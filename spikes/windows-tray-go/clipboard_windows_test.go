//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// This changes the OS clipboard. Enable only in a dedicated test user/session.
func TestClipboardDiagnosticsAreExactJSON(t *testing.T) {
	if os.Getenv("MURMUR_TRAY_CLIPBOARD_TEST") != "1" {
		t.Skip("requires a dedicated Windows clipboard: MURMUR_TRAY_CLIPBOARD_TEST=1")
	}
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	powershell := filepath.Join(dir, "WindowsPowerShell", "v1.0", "powershell.exe")
	call := func(script string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, powershell, "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
		hideConsole(cmd)
		return cmd.CombinedOutput()
	}
	t.Cleanup(func() {
		if out, err := call("Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::Clear()"); err != nil {
			t.Errorf("clipboard cleanup: %v: %s", err, out)
		}
	})
	for _, message := range []string{"plain ASCII", "Ключи не копируются 🛰️ — 東京", "quotes: \" ' ` $() ; |\nnext line"} {
		want, err := json.Marshal(map[string]string{"message": message})
		if err != nil {
			t.Fatal(err)
		}
		if err := toClipboard(want); err != nil {
			t.Fatal(err)
		}
		// Read through the OS consumer, not our encoder; strict JSON must parse
		// without trimming a BOM or repairing any character.
		out, err := call("$ErrorActionPreference='Stop'; $text=Get-Clipboard -Raw; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))")
		if err != nil {
			t.Fatalf("read clipboard: %v: %s", err, out)
		}
		got, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(out)))
		if err != nil {
			t.Fatal(err)
		}
		if !json.Valid(got) || !bytes.Equal(got, want) {
			t.Fatalf("clipboard is not exact valid JSON: got %q, want %q", got, want)
		}
	}
}
