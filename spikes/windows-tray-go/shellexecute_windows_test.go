//go:build windows

package main

import (
	"testing"
	"unsafe"
)

// ShellExecuteExW rejects a structure whose cbSize is not the documented SHELLEXECUTEINFOW size.
func TestShellExecuteInfoMatchesTheWindowsLayout(t *testing.T) {
	want := uintptr(60) // 32-bit
	if unsafe.Sizeof(uintptr(0)) == 8 {
		want = 112
	}
	if got := unsafe.Sizeof(shellExecuteInfo{}); got != want {
		t.Fatalf("sizeof(SHELLEXECUTEINFOW) = %d, want %d", got, want)
	}
	if got := unsafe.Offsetof(shellExecuteInfo{}.process); unsafe.Sizeof(uintptr(0)) == 8 && got != 104 {
		t.Fatalf("hProcess offset = %d, want 104", got)
	}
}
