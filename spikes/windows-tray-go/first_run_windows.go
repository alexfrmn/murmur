//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	firstRunJoin     = 101
	firstRunInvite   = 102
	firstRunExisting = 103
	firstRunEnglish  = 104
	firstRunRussian  = 105
)

var firstRunOpen atomic.Bool
var firstRunHWND atomic.Uintptr
var firstRunDialog = user32.NewProc("DialogBoxIndirectParamW")
var firstRunEnd = user32.NewProc("EndDialog")
var firstRunForeground = user32.NewProc("SetForegroundWindow")

// Standard Windows dialog template: native keyboard navigation, DPI/font scaling,
// Escape and the close button all work without a browser or a console process.
func firstRunTemplate() []byte {
	b := make([]byte, 0, 1024)
	word := func(v uint16) { b = binary.LittleEndian.AppendUint16(b, v) }
	dword := func(v uint32) { b = binary.LittleEndian.AppendUint32(b, v) }
	text := func(v string) {
		for _, c := range windows.StringToUTF16(v) {
			word(c)
		}
	}
	dword(0x80C808C0) // popup, caption, system menu, modal frame, font, centre
	dword(0)
	word(6)
	word(0)
	word(0)
	word(300)
	word(198)
	word(0)
	word(0)
	text("Murmur")
	word(10)
	text("Segoe UI")
	control := func(id, class, x, y, w, h uint16, style uint32, label string) {
		for len(b)%4 != 0 {
			b = append(b, 0)
		}
		dword(0x50000000 | style)
		dword(0)
		word(x)
		word(y)
		word(w)
		word(h)
		word(id)
		word(0xffff)
		word(class)
		text(label)
		word(0)
	}
	control(200, 0x82, 16, 12, 268, 28, 0, tr("firstRun.heading"))
	control(firstRunJoin, 0x80, 16, 48, 268, 28, 0x10001, tr("firstRun.join"))
	control(firstRunInvite, 0x80, 16, 82, 268, 28, 0x10000, tr("firstRun.invite"))
	control(firstRunExisting, 0x80, 16, 116, 268, 28, 0x10000, tr("firstRun.existing"))
	control(firstRunEnglish, 0x80, 16, 164, 128, 22, 0x10000, "English")
	control(firstRunRussian, 0x80, 156, 164, 128, 22, 0x10000, "Русский")
	return b
}

var firstRunCallback = syscall.NewCallback(func(hwnd uintptr, msg uint32, wparam, lparam uintptr) uintptr {
	switch msg {
	case 0x110: // WM_INITDIALOG
		firstRunHWND.Store(hwnd)
		// setup.exe starts the tray hidden; consume that startup hint, then show.
		user32.NewProc("ShowWindow").Call(hwnd, 5)
		user32.NewProc("ShowWindow").Call(hwnd, 5)
		firstRunForeground.Call(hwnd)
		return 1
	case 0x111: // WM_COMMAND (button or Escape)
		id := wparam & 0xffff
		if id == 2 || (id >= firstRunJoin && id <= firstRunRussian) {
			firstRunEnd.Call(hwnd, id)
			return 1
		}
	case 0x10: // WM_CLOSE
		firstRunEnd.Call(hwnd, 2)
		return 1
	}
	return 0
})

// The caller owns action dispatch. A language switch persists through the same
// callback as the tray menu, then reopens the dialog in the chosen language.
func showFirstRunWindow(changeLanguage func(string)) (int, error) {
	if !firstRunOpen.CompareAndSwap(false, true) {
		firstRunForeground.Call(firstRunHWND.Load())
		return 0, nil
	}
	defer firstRunOpen.Store(false)
	defer firstRunHWND.Store(0)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	for {
		template := firstRunTemplate()
		result, _, err := firstRunDialog.Call(0, uintptr(unsafe.Pointer(&template[0])), 0, firstRunCallback, 0)
		runtime.KeepAlive(template)
		if result == ^uintptr(0) {
			return 0, fmt.Errorf("first-run dialog: %w", err)
		}
		switch int(result) {
		case firstRunEnglish:
			changeLanguage(localeEnglish)
		case firstRunRussian:
			changeLanguage(localeRussian)
		default:
			return int(result), nil
		}
	}
}

type firstRunActions struct{ HaveInvitation, InviteColleague, UsedBefore func() }

func needsFirstRun() bool {
	if profile := os.Getenv("MURMUR_PROFILE"); profile != "" {
		return !isProfile(profile)
	}
	if os.Getenv("MURMUR_STATUS_FILE") != "" {
		return false
	}
	_, err := discoverIdentity(os.Getenv("LOCALAPPDATA"))
	return err != nil
}

func runFirstRun(actions firstRunActions, changeLanguage func(string)) error {
	choice, err := showFirstRunWindow(changeLanguage)
	if err != nil {
		return err
	}
	dispatchFirstRun(choice, actions)
	return nil
}

func dispatchFirstRun(choice int, actions firstRunActions) {
	switch choice {
	case firstRunJoin:
		actions.HaveInvitation()
	case firstRunInvite:
		actions.InviteColleague()
	case firstRunExisting:
		actions.UsedBefore()
	}
}

// A missing runtime never hides a choice. Download opens the official page only
// after a deliberate click; it does not fetch or execute an installer.
func withSetupNode(action func()) func() {
	return func() {
		if setupNodeAvailable() {
			action()
			return
		}
		if askYesNo("Murmur", tr("firstRun.nodeRequired")) {
			verb, _ := windows.UTF16PtrFromString("open")
			target, _ := windows.UTF16PtrFromString("https://nodejs.org/en/download")
			if err := windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL); err != nil {
				tell("Murmur", tr("firstRun.downloadFailed"))
			}
		}
	}
}

func setupNodeAvailable() bool {
	regular := func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular()
	}
	if explicit := os.Getenv("MURMUR_BIN"); explicit != "" {
		return filepath.IsAbs(explicit) && regular(explicit)
	}
	if exe, err := trayExecutable(); err == nil && regular(filepath.Join(filepath.Dir(exe), "node.exe")) {
		return true
	}
	_, err := lookNode()
	return err == nil
}
