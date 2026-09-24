//go:build windows

package main

import (
	"os"
	"runtime"
	"syscall"
	"testing"
	"unsafe"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
)

// Opt-in native menu proof uses the production menu and shared fixture, with no
// click handlers, polling, CLI, first-run, preferences or service mutations.
func TestNativeMenuAcceptance(t *testing.T) {
	if os.Getenv("MURMUR_MENU_PROOF") != "1" {
		t.Skip("native visual acceptance only")
	}
	// systray locks main during init; testing runs each test on a different
	// goroutine, which must keep window creation and pumping on one OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	setLocale(os.Getenv("MURMUR_PROOF_LOCALE"))
	s := load(t, "status-green.json")
	s.Service.State = "running-unmanaged"
	for i := range s.Peers.List {
		s.Peers.List[i].Connection = "unverified"
	}
	a := &app{status: s, pinnedAgent: s.AgentID, mStages: map[string]*systray.MenuItem{}, actionResult: "action.none"}
	a.assistantState, a.assistantIdentity = "ready", s.AgentID
	if os.Getenv("MURMUR_PROOF_MODE") == "missing" {
		a.status = nil
		a.statusErr = notConfigured()
		a.pinnedAgent = ""
	}
	systray.Run(func() {
		a.setupMenu()
		a.render(resolve(a.status, a.statusErr))
		// Make this harness's normally hidden owner window capturable. The menu
		// itself is unchanged and other processes' windows are ignored.
		callback := syscall.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
			var pid uint32
			windows.GetWindowThreadProcessId(hwnd, &pid)
			if pid != uint32(os.Getpid()) {
				return 1
			}
			name := make([]uint16, 64)
			if n, err := windows.GetClassName(hwnd, &name[0], 64); err == nil && windows.UTF16ToString(name[:n]) == "SystrayClass" {
				title, _ := windows.UTF16PtrFromString("Murmur menu proof - right-click to open")
				user32.NewProc("SetWindowTextW").Call(uintptr(hwnd), uintptr(unsafe.Pointer(title)))
				user32.NewProc("SetWindowPos").Call(uintptr(hwnd), 0, 150, 100, 1000, 750, 0x0040)
				// Right-click opens this harness menu after it receives foreground input.
				oldProc, _, _ := user32.NewProc("GetWindowLongPtrW").Call(uintptr(hwnd), ^uintptr(3))
				proc := syscall.NewCallback(func(window uintptr, message uint32, wp, lp uintptr) uintptr {
					if message == 0x205 {
						go openOwnMenu()
						return 0
					}
					value, _, _ := user32.NewProc("CallWindowProcW").Call(oldProc, window, uintptr(message), wp, lp)
					return value
				})
				user32.NewProc("SetWindowLongPtrW").Call(uintptr(hwnd), ^uintptr(3), proc)
			}
			return 1
		})
		windows.EnumWindows(callback, nil)
	}, func() {})
}
