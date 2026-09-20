//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"syscall"
)

func launchDetached(locale string) (int, error) {
	file, err := os.Executable()
	if err != nil {
		return 0, err
	}
	cmd := exec.Command(file, "--lang", locale)
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
