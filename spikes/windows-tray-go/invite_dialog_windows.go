//go:build windows

package main

import (
	"encoding/binary"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type inviteControl struct {
	id, class, x, y, w, h uint16
	style                 uint32
	text                  string
}

func inviteDialogTemplate(title string, height uint16, controls []inviteControl) []byte {
	b := []byte{}
	word := func(v uint16) { b = binary.LittleEndian.AppendUint16(b, v) }
	dword := func(v uint32) { b = binary.LittleEndian.AppendUint32(b, v) }
	text := func(v string) {
		for _, c := range windows.StringToUTF16(v) {
			word(c)
		}
	}
	dword(0x80C808C0)
	dword(0)
	word(uint16(len(controls)))
	word(0)
	word(0)
	word(330)
	word(height)
	word(0)
	word(0)
	text(title)
	word(10)
	text("Segoe UI")
	for _, c := range controls {
		for len(b)%4 != 0 {
			b = append(b, 0)
		}
		dword(0x50000000 | c.style)
		dword(0)
		word(c.x)
		word(c.y)
		word(c.w)
		word(c.h)
		word(c.id)
		word(0xffff)
		word(c.class)
		text(c.text)
		word(0)
	}
	return b
}

var inviteDialogMu sync.Mutex
var inviteDialogCommand func(uintptr, uintptr) bool
var inviteDialogCallback = syscall.NewCallback(func(hwnd uintptr, msg uint32, w, l uintptr) uintptr {
	switch msg {
	case 0x110:
		user32.NewProc("ShowWindow").Call(hwnd, 5)
		user32.NewProc("ShowWindow").Call(hwnd, 5)
		user32.NewProc("SetForegroundWindow").Call(hwnd)
		return 1
	case 0x111:
		id := w & 0xffff
		if id == 2 {
			user32.NewProc("EndDialog").Call(hwnd, 2)
			return 1
		}
		if inviteDialogCommand(hwnd, id) {
			return 1
		}
	case 0x10:
		user32.NewProc("EndDialog").Call(hwnd, 2)
		return 1
	}
	return 0
})

func runInviteDialog(template []byte, command func(uintptr, uintptr) bool) uintptr {
	inviteDialogMu.Lock()
	defer inviteDialogMu.Unlock()
	inviteDialogCommand = command
	defer func() { inviteDialogCommand = nil }()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, _ := user32.NewProc("DialogBoxIndirectParamW").Call(0, uintptr(unsafe.Pointer(&template[0])), 0, inviteDialogCallback, 0)
	runtime.KeepAlive(template)
	return result
}

func inviteField(hwnd uintptr, id uintptr) string {
	buf := make([]uint16, 4097)
	user32.NewProc("GetDlgItemTextW").Call(hwnd, id, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf)
}

func showInviteIdentity() (inviteIdentity, bool) {
	hostname, _ := os.Hostname()
	controls := []inviteControl{
		{200, 0x82, 16, 12, 298, 26, 0, tr("invite.createHeading")},
		{201, 0x82, 16, 44, 298, 14, 0, tr("invite.name")},
		{101, 0x81, 16, 60, 298, 20, 0x810080, hostname},
		{202, 0x82, 16, 88, 298, 14, 0, tr("invite.server")},
		{102, 0x81, 16, 104, 298, 20, 0x810080, ""},
		{203, 0x82, 16, 128, 298, 14, 0, tr("invite.serverExample")},
		{204, 0x82, 16, 152, 298, 14, 0, tr("invite.key")},
		{103, 0x81, 16, 168, 298, 20, 0x8100A0, ""},
		{205, 0x82, 16, 198, 298, 28, 0, tr("invite.createHint")},
		{1, 0x80, 16, 234, 190, 26, 0x10001, tr("invite.create")},
		{2, 0x80, 214, 234, 100, 26, 0x10000, tr("invite.cancel")},
	}
	var input inviteIdentity
	result := runInviteDialog(inviteDialogTemplate(tr("invite.title"), 276, controls), func(hwnd, id uintptr) bool {
		if id != 1 {
			return false
		}
		input = inviteIdentity{strings.TrimSpace(inviteField(hwnd, 101)), strings.TrimSpace(inviteField(hwnd, 102)), inviteField(hwnd, 103)}
		if input.Name == "" || input.Server == "" {
			tell(tr("invite.title"), tr("invite.required"))
			return true
		}
		input.Server = normalizeInviteServer(input.Server)
		user32.NewProc("EndDialog").Call(hwnd, 1)
		return true
	})
	return input, result == 1
}

func showInvitePublicServer(copyDiagnostics func()) (string, bool) {
	controls := []inviteControl{
		{200, 0x82, 16, 12, 298, 45, 0, tr("invite.publicAddressHint")},
		{201, 0x82, 16, 66, 298, 14, 0, tr("invite.publicAddress")},
		{101, 0x81, 16, 82, 298, 20, 0x810080, ""},
		{202, 0x82, 16, 108, 298, 14, 0, tr("invite.serverExample")},
		{3, 0x80, 16, 134, 298, 24, 0x10000, tr("invite.copyDiagnostics")},
		{1, 0x80, 16, 168, 198, 26, 0x10001, tr("invite.retry")},
		{2, 0x80, 222, 168, 92, 26, 0x10000, tr("invite.cancel")},
	}
	var address string
	result := runInviteDialog(inviteDialogTemplate(tr("invite.title"), 210, controls), func(hwnd, id uintptr) bool {
		if id == 3 {
			copyDiagnostics()
			return true
		}
		if id != 1 {
			return false
		}
		address = strings.TrimSpace(inviteField(hwnd, 101))
		if address == "" {
			tell(tr("invite.title"), tr("invite.publicAddressRequired"))
			return true
		}
		user32.NewProc("EndDialog").Call(hwnd, 1)
		return true
	})
	return address, result == 1
}

func showInviteError(message string, copyDiagnostics func()) {
	controls := []inviteControl{
		{200, 0x82, 16, 12, 298, 58, 0, message},
		{1, 0x80, 16, 80, 198, 26, 0x10001, tr("invite.copyDiagnostics")},
		{2, 0x80, 222, 80, 92, 26, 0x10000, tr("invite.close")},
	}
	runInviteDialog(inviteDialogTemplate(tr("invite.title"), 122, controls), func(hwnd, id uintptr) bool {
		if id != 1 {
			return false
		}
		copyDiagnostics()
		return true
	})
}
