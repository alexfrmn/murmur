package main

import (
	"bytes"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Each refusal happens before opening or modifying a selected SCM service.
// Build this checkout so a stale helper next to the tests cannot hide a failure.
func TestNativeHelperWritesFinalReasonWithoutServiceMutation(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "helper кириллица.exe")
	if output, err := exec.Command("go", "build", "-o", exe, ".").CombinedOutput(); err != nil {
		t.Fatalf("build helper: %v\n%s", err, output)
	}
	t.Setenv("MURMUR_SERVICE_NAME", "invalid/name")
	for _, tc := range []struct {
		args   []string
		reason string
		code   int
	}{
		{[]string{"--lang", "invalid", "status"}, "error.language", 1},
		{[]string{"status"}, "error.unknown", 1},
		{nil, "usage.line", 2},
	} {
		cmd := exec.Command(exe, tc.args...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != tc.code {
			t.Fatalf("%q exit = %v, want %d", tc.args, err, tc.code)
		}
		if stdout.Len() != 0 || !strings.HasSuffix(stderr.String(), "\nmurmur-svc: reason="+tc.reason+"\n") {
			t.Fatalf("%q stdout=%q stderr=%q", tc.args, stdout.String(), stderr.String())
		}
	}
	cmd := exec.Command(exe, "--version")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if output, err := cmd.Output(); err != nil || len(output) == 0 || stderr.Len() != 0 {
		t.Fatalf("version emitted a failure: %v, stderr=%q", err, stderr.String())
	}
}
