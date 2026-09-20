//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// clip.exe retained our UTF-16 BOM as U+FEFF in the clipboard, making copied
// diagnostics invalid JSON. Set UnicodeText explicitly in a bounded STA process.
// The script is fixed; payload bytes travel as base64 on stdin, never as code.
func toClipboard(data []byte) error {
	if !json.Valid(data) {
		return fmt.Errorf("%s", tr("clipboard.invalid"))
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		return err
	}
	windowsDir, err := windows.GetWindowsDirectory()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const script = `$ErrorActionPreference='Stop'; [Console]::Error.WriteLine('clipboard: initialize'); [void][Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089'); [Console]::Error.WriteLine('clipboard: input'); $text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); [Console]::Error.WriteLine('clipboard: write'); [Windows.Forms.Clipboard]::SetText($text,[Windows.Forms.TextDataFormat]::UnicodeText); [Console]::Error.WriteLine('clipboard: complete')`
	cmd := exec.CommandContext(ctx, filepath.Join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
	cmd.Env = []string{"SystemRoot=" + windowsDir, "WINDIR=" + windowsDir}
	cmd.Stdin = strings.NewReader(base64.StdEncoding.EncodeToString(data))
	cmd.Stdout = io.Discard
	var stderr boundedOutput
	cmd.Stderr = &stderr
	hideConsole(cmd)
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("%s", tr("clipboard.commandFailed", ctx.Err(), strings.TrimSpace(stderr.String())))
		}
		return fmt.Errorf("%s", tr("clipboard.commandFailed", err, strings.TrimSpace(stderr.String())))
	}
	return nil
}
