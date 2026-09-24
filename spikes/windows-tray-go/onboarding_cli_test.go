package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Two real CLI profiles, no Service or Assistant mutation and no exchange files.
func TestOnboardingAgainstTheRealCLI(t *testing.T) {
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
	exchange := filepath.Join(sandbox, "exchange")
	os.MkdirAll(exchange, 0700)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	inviter := cliBinding{Node: node, Entry: filepath.Join(root, "packages", "setup", "bin", "murmur.mjs"), Profile: filepath.Join(exchange, "a")}
	cli := func(args ...string) ([]byte, error) { return runSetupCLI(ctx, inviter, inviter.arguments(args)[1:]...) }
	if _, err := cli("init", "--agent-id", "fixture-a", "--broker-url", "nats://server.example.com:4222", "--json"); err != nil {
		t.Fatal(err)
	}
	out, err := cli("invite", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var invitation struct{ Schema, Invitation string }
	if json.Unmarshal(out, &invitation) != nil || invitation.Schema != "murmur.invite/1" {
		t.Fatal("bad invitation receipt")
	}
	me := inviter
	me.Profile = filepath.Join(exchange, "b")
	shown := ""
	steps := onboardingSteps{
		pickInvitation: func() (string, bool) { return invitation.Invitation, true },
		showReply:      func(line string) { shown = line },
		cliInput:       func(line string, args ...string) ([]byte, error) { return runSetupCLIInput(ctx, me, line, args...) },
		cli:            func(args ...string) ([]byte, error) { return runSetupCLI(ctx, me, args...) },
		confirm:        func(string, string) bool { return false }, inform: func(string, string) {},
		elevated: func(...string) error { t.Fatal("unexpected elevation"); return nil },
	}
	result, err := runOnboarding(steps, me.Profile, "fixture-b")
	if err != nil {
		t.Fatal(err)
	}
	if shown == "" || shown != result.Reply {
		t.Fatal("Reply was not shown")
	}
	input := func(line string, args ...string) ([]byte, error) {
		return runSetupCLIInput(ctx, inviter, line, inviter.arguments(args)[1:]...)
	}
	peer, err := importReply(cli, input, "fixture-a", result.Reply)
	if err != nil || peer != "fixture-b" {
		t.Fatal("reply import failed", err)
	}
	for _, v := range []struct {
		b    cliBinding
		peer string
	}{{inviter, "fixture-b"}, {me, "fixture-a"}} {
		data, err := os.ReadFile(filepath.Join(v.b.Profile, "agent-config.json"))
		if err != nil {
			t.Fatal(err)
		}
		var config struct{ Peers map[string]json.RawMessage }
		if json.Unmarshal(data, &config) != nil || config.Peers[v.peer] == nil {
			t.Fatal("mutual Contact missing")
		}
	}
	files, err := os.ReadDir(exchange)
	if err != nil || len(files) != 2 {
		t.Fatal("unexpected exchange file")
	}
	before, err := os.ReadFile(filepath.Join(inviter.Profile, "agent-config.json"))
	if err != nil {
		t.Fatal(err)
	}
	// Wrong message type and messenger-truncated input cannot change the inviter.
	for _, line := range []string{invitation.Invitation, result.Reply[:len(result.Reply)/2]} {
		if _, err := importReply(cli, input, "fixture-a", line); err == nil {
			t.Fatal("invalid Reply accepted")
		}
		after, _ := os.ReadFile(filepath.Join(inviter.Profile, "agent-config.json"))
		if !bytes.Equal(before, after) {
			t.Fatal("invalid Reply changed Identity")
		}
	}
}
