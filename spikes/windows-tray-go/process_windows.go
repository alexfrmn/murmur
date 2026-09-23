//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

func launchDetached(locale string) (int, error) {
	file, err := os.Executable()
	if err != nil {
		return 0, err
	}
	cmd := exec.Command(file, "--launcher-start", "--lang", locale)
	cmd.Env = os.Environ() // The launcher already supplied the explicit binding.
	// Do not retain the launcher's capture/console handles. A tray lives longer
	// than its launcher; inheriting those handles keeps callers waiting for EOF.
	cmd.SysProcAttr = &syscall.SysProcAttr{NoInheritHandles: true, CreationFlags: 0x00000008, HideWindow: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	return pid, cmd.Process.Release()
}

func hideConsole(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func serviceAdmin() bool {
	sid, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return false
	}
	ok, err := windows.Token(0).IsMember(sid)
	return err == nil && ok
}

// shellExecuteInfo mirrors SHELLEXECUTEINFOW; x/sys/windows v0.15 has no ShellExecuteEx.
type shellExecuteInfo struct {
	cbSize      uint32
	fMask       uint32
	hwnd        windows.Handle
	verb        *uint16
	file        *uint16
	parameters  *uint16
	directory   *uint16
	show        int32
	instApp     windows.Handle
	idList      uintptr
	class       *uint16
	keyClass    windows.Handle
	hotKey      uint32
	iconMonitor windows.Handle
	process     windows.Handle
}

var procShellExecuteExW = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")

// runElevated asks Windows for consent (UAC) once and runs file with args as administrator,
// waiting for it to finish. The elevated process cannot hand back its output, so the caller
// relies on the exit code (the CLI confirms the service state before returning 0) and a fresh
// status read. A declined prompt returns errElevationCancelled.
func runElevated(ctx context.Context, file string, args []string, dir string) error {
	const maskNoCloseProcess, maskNoAsync, maskFlagNoUI = 0x40, 0x100, 0x400
	verb, _ := windows.UTF16PtrFromString("runas")
	path, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return err
	}
	params, err := windows.UTF16PtrFromString(elevatedCommandLine(args))
	if err != nil {
		return err
	}
	cwd, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	info := shellExecuteInfo{fMask: maskNoCloseProcess | maskNoAsync | maskFlagNoUI, verb: verb, file: path, parameters: params, directory: cwd, show: windows.SW_HIDE}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if ok, _, callErr := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info))); ok == 0 {
		if errors.Is(callErr, windows.ERROR_CANCELLED) {
			return errElevationCancelled
		}
		return callErr
	}
	defer windows.CloseHandle(info.process)
	deadline := uint32(windows.INFINITE)
	if d, ok := ctx.Deadline(); ok {
		deadline = uint32(max(0, time.Until(d).Milliseconds()))
	}
	if event, err := windows.WaitForSingleObject(info.process, deadline); err != nil || event != windows.WAIT_OBJECT_0 {
		return errElevatedTimeout
	}
	var code uint32
	if err := windows.GetExitCodeProcess(info.process, &code); err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("%s", tr("action.elevatedFailed", code))
	}
	return nil
}
