//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestTrayInstanceKeyIgnoresCaseAndRedundantSeparators(t *testing.T) {
	a := trayInstanceKey(`C:\Program Files\Murmur\murmur-tray.exe`)
	if a != trayInstanceKey(`c:\program files\murmur\\MURMUR-TRAY.EXE`) {
		t.Fatal("the same executable must give the same key")
	}
	if a == trayInstanceKey(`C:\Users\u\Мой Murmur\murmur-tray.exe`) {
		t.Fatal("another bundle must get its own key")
	}
}

func TestSecondClaimSignalsTheFirstAndLastExitFreesTheName(t *testing.T) {
	key := fmt.Sprintf("test-%d-%d", os.Getpid(), time.Now().UnixNano())
	first, err := claimTray(key)
	if err != nil || first == nil {
		t.Fatalf("first claim: %v %v", first, err)
	}
	second, err := claimTray(key)
	if err != nil || second != nil {
		t.Fatalf("second claim must defer to the first: %v %v", second, err)
	}
	if result, _ := windows.WaitForSingleObject(first.show, 0); result != windows.WAIT_OBJECT_0 {
		t.Fatal("the second claim did not ask the first tray to show itself")
	}
	windows.CloseHandle(first.mutex)
	windows.CloseHandle(first.show)
	third, err := claimTray(key)
	if err != nil || third == nil {
		t.Fatalf("after the first tray exits a new one must start: %v %v", third, err)
	}
	windows.CloseHandle(third.mutex)
	windows.CloseHandle(third.show)
}

// The path of the review: the exact tray executable started twice directly, as two shortcut clicks do.
func TestDirectRepeatedLaunchLeavesOneTray(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and starts the tray")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "Мой Murmur", "murmur-tray.exe")
	build := exec.Command("go", "build", "-o", exe, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	local := filepath.Join(dir, "local")
	if err := os.MkdirAll(local, 0o700); err != nil {
		t.Fatal(err)
	}
	env := []string{"LOCALAPPDATA=" + local, "APPDATA=" + local, "MURMUR_UPDATE_CHECK=0"}
	for _, v := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(v, "=", 2)[0])
		if !strings.HasPrefix(key, "MURMUR_") && key != "LOCALAPPDATA" && key != "APPDATA" && key != "DATA_DIR" {
			env = append(env, v)
		}
	}
	start := func() *exec.Cmd {
		cmd := exec.Command(exe)
		cmd.Env = env
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		return cmd
	}
	running := func(cmd *exec.Cmd) chan error {
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		return done
	}
	claimed := func() bool {
		name, _ := windows.UTF16PtrFromString(`Local\MurmurTray-` + trayInstanceKey(exe))
		h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, name)
		if err == nil {
			windows.CloseHandle(h)
		}
		return err == nil
	}
	waitClaimed := func() {
		for deadline := time.Now().Add(10 * time.Second); !claimed(); time.Sleep(50 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("the tray did not start")
			}
		}
	}

	first := start()
	firstDone := running(first)
	t.Cleanup(func() { _ = first.Process.Kill() })
	waitClaimed()

	second := start()
	select {
	case err := <-running(second):
		if err != nil {
			t.Fatalf("the second launch must exit with 0: %v", err)
		}
	case <-time.After(10 * time.Second):
		_ = second.Process.Kill()
		t.Fatal("the second launch stayed running: two trays")
	}
	select {
	case err := <-firstDone:
		t.Fatalf("the first tray exited: %v", err)
	case <-time.After(500 * time.Millisecond):
	}

	_ = first.Process.Kill()
	<-firstDone
	third := start()
	thirdDone := running(third)
	t.Cleanup(func() { _ = third.Process.Kill() })
	waitClaimed()
	select {
	case err := <-thirdDone:
		t.Fatalf("after the first tray exited a new launch must stay: %v", err)
	case <-time.After(1500 * time.Millisecond):
	}
}
