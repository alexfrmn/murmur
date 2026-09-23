//go:build windows

package main

import (
	"testing"
	"unsafe"
)

// GetOpenFileNameW rejects a structure whose size is not the documented OPENFILENAMEW size.
func TestOpenFileNameMatchesTheWindowsLayout(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("64-bit layout")
	}
	if got := unsafe.Sizeof(openFileName{}); got != 152 {
		t.Fatalf("sizeof(OPENFILENAMEW) = %d, want 152", got)
	}
}
