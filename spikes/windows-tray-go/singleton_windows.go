//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// One tray per bundle in a Windows session. Start menu, Desktop and Startup shortcuts all start
// murmur-tray.exe directly, so a second click must not add a second icon: it asks the running
// tray to open its menu and exits with 0. The name follows the launcher's rule (same executable
// path, same session): Local\ is per session, the hash is of the full executable path.
type trayInstance struct{ mutex, show windows.Handle }

var (
	procAllowSetForeground = user32.NewProc("AllowSetForegroundWindow")
	procPostMessage        = user32.NewProc("PostMessageW")
)

func trayInstanceKey(exe string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(exe))))
	return hex.EncodeToString(sum[:8])
}

// claimTray returns the instance when this process is the first tray for key; otherwise it asks
// the first one to show itself and returns nil.
func claimTray(key string) (*trayInstance, error) {
	showName, err := windows.UTF16PtrFromString(`Local\MurmurTrayShow-` + key)
	if err != nil {
		return nil, err
	}
	mutexName, err := windows.UTF16PtrFromString(`Local\MurmurTray-` + key)
	if err != nil {
		return nil, err
	}
	// The event exists before the mutex, so a second instance that sees the mutex can always signal.
	show, err := windows.CreateEvent(nil, 0, 0, showName)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, err
	}
	mutex, err := windows.CreateMutex(nil, false, mutexName)
	if err == nil {
		return &trayInstance{mutex: mutex, show: show}, nil
	}
	if mutex != 0 {
		windows.CloseHandle(mutex)
	}
	defer windows.CloseHandle(show)
	if !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, err
	}
	// The running tray opens its menu; this process was started by the click and may hand over
	// the foreground so the menu is not hidden behind the Start menu.
	const asfwAny = ^uintptr(0)
	procAllowSetForeground.Call(asfwAny)
	return nil, windows.SetEvent(show)
}

// wait blocks until another launch asks this tray to show itself.
func (t *trayInstance) wait() bool {
	result, err := windows.WaitForSingleObject(t.show, windows.INFINITE)
	return err == nil && result == windows.WAIT_OBJECT_0
}

// openOwnMenu posts to this process's systray window the message a right click on the icon sends.
func openOwnMenu() error {
	pid := uint32(os.Getpid())
	var target windows.HWND
	callback := syscall.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		var owner uint32
		if _, err := windows.GetWindowThreadProcessId(hwnd, &owner); err != nil || owner != pid {
			return 1
		}
		name := make([]uint16, 64)
		if n, err := windows.GetClassName(hwnd, &name[0], int32(len(name))); err == nil && windows.UTF16ToString(name[:n]) == "SystrayClass" {
			target = hwnd
			return 0
		}
		return 1
	})
	_ = windows.EnumWindows(callback, unsafe.Pointer(nil))
	if target == 0 {
		return errors.New("tray window not found")
	}
	const wmUser, wmRButtonUp = 0x0400, 0x0205
	if ok, _, err := procPostMessage.Call(uintptr(target), wmUser+1, 0, wmRButtonUp); ok == 0 {
		return err
	}
	return nil
}
