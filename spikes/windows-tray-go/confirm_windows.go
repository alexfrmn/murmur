//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func confirmTrayExit() bool {
	body, _ := windows.UTF16PtrFromString(tr("quit.confirm"))
	title, _ := windows.UTF16PtrFromString(tr("quit.title"))
	// MB_OKCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2. Escape/close/failure
	// preserve the only running tray; the default button is Cancel.
	result, _, _ := windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(
		0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x121)
	return result == 1
}
