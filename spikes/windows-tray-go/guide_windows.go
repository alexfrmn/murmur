//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"sync/atomic"

	"golang.org/x/sys/windows"
)

const guideWindowTitle = "Murmur"

var guideOpen atomic.Bool

type launcherGuideSignal struct{ event windows.Handle }

func newLauncherGuideSignal(enabled bool) (*launcherGuideSignal, error) {
	if !enabled {
		return nil, nil
	}
	name, err := windows.UTF16PtrFromString(fmt.Sprintf(`Local\MurmurGuideReady-%d`, os.Getpid()))
	if err != nil {
		return nil, err
	}
	event, err := windows.CreateEvent(nil, 0, 0, name)
	if err != nil {
		return nil, err
	}
	return &launcherGuideSignal{event: event}, nil
}

func (s *launcherGuideSignal) wait() bool {
	defer windows.CloseHandle(s.event)
	result, err := windows.WaitForSingleObject(s.event, windows.INFINITE)
	return err == nil && result == windows.WAIT_OBJECT_0
}

// showNativeGuide runs outside the systray callback thread. Windows owns the
// dialog until the person explicitly dismisses it; a second request never
// creates a second, hidden modal window.
func showNativeGuide() (bool, error) {
	if !guideOpen.CompareAndSwap(false, true) {
		return false, nil
	}
	defer guideOpen.Store(false)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	body, err := windows.UTF16PtrFromString(tr("guide.body"))
	if err != nil {
		return false, err
	}
	title, err := windows.UTF16PtrFromString(guideWindowTitle)
	if err != nil {
		return false, err
	}
	result, err := windows.MessageBox(0, body, title, windows.MB_OK|windows.MB_ICONINFORMATION|windows.MB_SETFOREGROUND)
	return result == 1, err
}
