package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInviteBackupDirIsOutsideTheProfile(t *testing.T) {
	for _, profile := range []string{filepath.Join("base", "Murmur"), filepath.Join("base", "Murmur") + string(filepath.Separator), filepath.Join("a", "b", "profile")} {
		dir := inviteBackupDir(profile)
		rel, err := filepath.Rel(filepath.Clean(profile), dir)
		if err != nil || !strings.HasPrefix(rel, "..") {
			t.Fatalf("%q is inside profile %q", dir, profile)
		}
		if filepath.Dir(dir) != filepath.Dir(filepath.Clean(profile)) {
			t.Fatalf("%q is not next to profile %q", dir, profile)
		}
	}
}

// The engine rejects an Invitation written inside its own profile; the tray's
// backup folder must be accepted by the real CLI.
func TestInviteBackupDirAgainstTheRealCLI(t *testing.T) {
	node, err := exec.LookPath("node")
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	if err != nil || !fileExists(filepath.Join(root, "packages", "setup", "dist", "src", "cli.js")) {
		t.Skip("built setup engine and Node required")
	}
	sandbox := t.TempDir()
	home := filepath.Join(sandbox, "home")
	os.MkdirAll(home, 0700)
	for _, key := range []string{"HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"} {
		t.Setenv(key, home)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	b := cliBinding{Node: node, Entry: filepath.Join(root, "packages", "setup", "bin", "murmur.mjs"), Profile: filepath.Join(sandbox, "Murmur")}
	cli := func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, b.arguments(args)[1:]...) }
	if _, err := cli("init", "--agent-id", "fixture-a", "--broker-url", "nats://server.example.com:4222", "--json"); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(b.Profile, "invites")
	os.MkdirAll(inside, 0700)
	if _, err := cli("invite", "--out", filepath.Join(inside, "invite-1.txt"), "--json"); err == nil || !strings.Contains(err.Error(), "output-inside-profile") {
		t.Fatalf("an Invitation inside the profile was not refused as expected: %v", err)
	}
	dir := inviteBackupDir(b.Profile)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "invite-1.txt")
	out, err := cli("invite", "--out", path, "--json")
	if err != nil {
		t.Fatal(err)
	}
	line, _, err := invitationContent(out, path)
	if err != nil || !strings.HasPrefix(line, "MURMUR:") {
		t.Fatalf("backup Invitation not usable: %v", err)
	}
}
