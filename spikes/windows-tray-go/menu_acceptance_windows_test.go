//go:build windows

package main

import (
	"os"
	"syscall"
	"testing"
	"time"
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
	setLocale(os.Getenv("MURMUR_PROOF_LOCALE"))
	s := load(t, "status-green.json")
	s.Service.State = "running-unmanaged"
	a := &app{status: s, pinnedAgent: s.AgentID, mStages: map[string]*systray.MenuItem{}, actionResult: "action.none"}
	systray.Run(func() {
		a.setupMenu()
		a.render(resolve(s, nil))
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
				title, _ := windows.UTF16PtrFromString("Murmur native menu proof")
				user32.NewProc("SetWindowTextW").Call(uintptr(hwnd), uintptr(unsafe.Pointer(title)))
				user32.NewProc("SetWindowPos").Call(uintptr(hwnd), 0, 150, 100, 1000, 750, 0x0040)
			}
			return 1
		})
		windows.EnumWindows(callback, nil)
		time.Sleep(time.Second)
		if err := openOwnMenu(); err != nil {
			t.Error(err)
			systray.Quit()
		}
	}, func() {})
}
