//go:build windows

package main

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const messagesUpdated = 0x8000 + 73

var messagesOpen atomic.Bool
var messagesWindow atomic.Uintptr
var activeMessages atomic.Pointer[messagesController]

type messagesController struct {
	mu           sync.Mutex
	load         func(context.Context, string, bool) (*inboxSnapshot, error)
	cancel       context.CancelFunc
	ctx          context.Context
	hwnd, list   uintptr
	busy, closed bool
	expected     string
	snapshot     *inboxSnapshot
	problem      bool
}

func (c *messagesController) request(mark bool) {
	c.mu.Lock()
	if c.busy || c.closed || (mark && (c.snapshot == nil || len(c.snapshot.Messages) == 0)) {
		c.mu.Unlock()
		return
	}
	c.busy = true
	expected := c.expected
	c.mu.Unlock()
	c.draw()
	go func() {
		snapshot, err := c.load(c.ctx, expected, mark)
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.closed {
			return
		}
		c.busy, c.problem = false, err != nil
		c.snapshot = snapshot
		if snapshot != nil {
			c.expected = snapshot.AgentID
		}
		user32.NewProc("PostMessageW").Call(c.hwnd, messagesUpdated, 0, 0)
	}()
}

func setNativeText(hwnd uintptr, text string) {
	value, _ := windows.UTF16PtrFromString(text)
	user32.NewProc("SetWindowTextW").Call(hwnd, uintptr(unsafe.Pointer(value)))
	runtime.KeepAlive(value)
}
func dialogItem(hwnd, id uintptr) uintptr {
	h, _, _ := user32.NewProc("GetDlgItem").Call(hwnd, id)
	return h
}
func enableNative(hwnd uintptr, enabled bool) {
	flag := uintptr(0)
	if enabled {
		flag = 1
	}
	user32.NewProc("EnableWindow").Call(hwnd, flag)
}

type nativeListColumn struct {
	Mask                                                               uint32
	Format, Width                                                      int32
	Text                                                               *uint16
	TextMax, Subitem, Image, Order, MinWidth, DefaultWidth, IdealWidth int32
}
type nativeListItem struct {
	Mask             uint32
	Item, Subitem    int32
	State, StateMask uint32
	Text             *uint16
	TextMax, Image   int32
	Param            uintptr
	Indent, GroupID  int32
	Columns          uint32
	ColumnIDs        *uint32
	ColumnFormats    *int32
	Group            int32
}

func listText(hwnd uintptr, row, col int, text string) {
	value, _ := windows.UTF16PtrFromString(text)
	item := nativeListItem{Mask: 1, Item: int32(row), Subitem: int32(col), Text: value}
	message := uintptr(0x1000 + 116) // LVM_SETITEMTEXTW
	if col == 0 {
		message = 0x1000 + 77
	} // LVM_INSERTITEMW
	user32.NewProc("SendMessageW").Call(hwnd, message, uintptr(row), uintptr(unsafe.Pointer(&item)))
	runtime.KeepAlive(value)
}

func (c *messagesController) createList() {
	icc := struct{ Size, Classes uint32 }{8, 1}
	windows.NewLazySystemDLL("comctl32.dll").NewProc("InitCommonControlsEx").Call(uintptr(unsafe.Pointer(&icc)))
	parent := dialogItem(c.hwnd, 104)
	var rect struct{ Left, Top, Right, Bottom int32 }
	user32.NewProc("GetClientRect").Call(parent, uintptr(unsafe.Pointer(&rect)))
	class, _ := windows.UTF16PtrFromString("SysListView32")
	c.list, _, _ = user32.NewProc("CreateWindowExW").Call(0x200, uintptr(unsafe.Pointer(class)), 0, 0x5001000D, 0, 0, uintptr(rect.Right), uintptr(rect.Bottom), parent, 105, 0, 0)
	font, _, _ := user32.NewProc("SendMessageW").Call(c.hwnd, 0x31, 0, 0)
	user32.NewProc("SendMessageW").Call(c.list, 0x30, font, 1)
	user32.NewProc("SendMessageW").Call(c.list, 0x1000+54, 0, 0x4021) // full row + grid + label tips
	for i, key := range []string{"messages.who", "messages.when", "messages.assistantRead", "messages.text"} {
		value, _ := windows.UTF16PtrFromString(tr(key))
		width := []int32{rect.Right * 17 / 100, rect.Right * 19 / 100, rect.Right * 26 / 100, rect.Right*38/100 - 8}[i]
		col := nativeListColumn{Mask: 7, Width: width, Text: value}
		user32.NewProc("SendMessageW").Call(c.list, 0x1000+97, uintptr(i), uintptr(unsafe.Pointer(&col)))
		runtime.KeepAlive(value)
	}
}

func (c *messagesController) draw() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	status := tr("messages.readHint")
	if c.snapshot != nil && c.snapshot.Unread != nil {
		status = tr("messages.unreadCount", *c.snapshot.Unread) + " " + status
	}
	if c.busy {
		status = tr("messages.loading")
	} else if c.problem {
		status = tr("messages.failed")
	}
	setNativeText(dialogItem(c.hwnd, 101), status)
	enableNative(dialogItem(c.hwnd, 102), !c.busy)
	enableNative(dialogItem(c.hwnd, 103), !c.busy && !c.problem && c.snapshot != nil && len(c.snapshot.Messages) > 0)
	user32.NewProc("SendMessageW").Call(c.list, 0x1000+9, 0, 0)
	if c.snapshot == nil {
		return
	}
	if len(c.snapshot.Messages) == 0 {
		listText(c.list, 0, 0, tr("messages.empty"))
		return
	}
	for i, message := range c.snapshot.Messages {
		for col, text := range messageColumns(message) {
			listText(c.list, i, col, text)
		}
	}
}

var messagesCallback = syscall.NewCallback(func(hwnd uintptr, msg uint32, w, l uintptr) uintptr {
	c := activeMessages.Load()
	if c == nil {
		return 0
	}
	switch msg {
	case 0x110:
		c.hwnd = hwnd
		messagesWindow.Store(hwnd)
		c.createList()
		user32.NewProc("ShowWindow").Call(hwnd, 5)
		user32.NewProc("SetForegroundWindow").Call(hwnd)
		c.request(false)
		return 1
	case messagesUpdated:
		c.draw()
		return 1
	case 0x111:
		switch w & 0xffff {
		case 102:
			c.request(false)
			return 1
		case 103:
			c.request(true)
			return 1
		case 2:
			msg = 0x10
		}
	}
	if msg == 0x10 {
		c.mu.Lock()
		c.closed = true
		c.cancel()
		c.mu.Unlock()
		user32.NewProc("EndDialog").Call(hwnd, 2)
		return 1
	}
	return 0
})

func showMessagesWindow(expected string, load func(context.Context, string, bool) (*inboxSnapshot, error)) {
	if !messagesOpen.CompareAndSwap(false, true) {
		user32.NewProc("SetForegroundWindow").Call(messagesWindow.Load())
		return
	}
	defer messagesOpen.Store(false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &messagesController{expected: expected, load: load, ctx: ctx, cancel: cancel}
	activeMessages.Store(c)
	defer activeMessages.Store(nil)
	defer messagesWindow.Store(0)
	controls := []inviteControl{
		{101, 0x82, 12, 10, 576, 30, 0x80, tr("messages.loading")},
		{104, 0x82, 12, 43, 576, 216, 0, ""},
		{102, 0x80, 12, 272, 112, 24, 0x10000, tr("messages.refresh")},
		{103, 0x80, 132, 272, 290, 24, 0x10000, tr("messages.markRead")},
		{2, 0x80, 476, 272, 112, 24, 0x10000, tr("invite.close")},
	}
	template := nativeDialogTemplate(tr("messages.title"), 600, 308, controls)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, _ := user32.NewProc("DialogBoxIndirectParamW").Call(0, uintptr(unsafe.Pointer(&template[0])), 0, messagesCallback, 0)
	runtime.KeepAlive(template)
	if result == ^uintptr(0) {
		tell(tr("messages.title"), tr("messages.failed"))
	}
}

func (a *app) openMessages() {
	b, err := selectedCLI()
	if err != nil {
		tell(tr("messages.title"), tr("menu.needIdentity"))
		return
	}
	a.mu.Lock()
	expected := a.pinnedAgent
	a.mu.Unlock()
	showMessagesWindow(expected, func(ctx context.Context, identity string, mark bool) (*inboxSnapshot, error) {
		selected, err := selectedCLI()
		if err != nil || selected != b {
			return nil, errors.New("inbox.selection-changed")
		}
		ctx, cancel := context.WithTimeout(ctx, cliTimeout)
		defer cancel()
		cli := func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, b.arguments(args)[1:]...) }
		return readMessages(cli, identity, mark)
	})
}
