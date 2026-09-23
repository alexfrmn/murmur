package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Runs the onboarding flow against the repository's real CLI, so every argument it passes is one
// the CLI accepts. Needs node and a built packages/setup; skipped otherwise.
func TestOnboardingAgainstTheRealCLI(t *testing.T) {
	node, err := exec.LookPath("node")
	entry, _ := filepath.Abs(filepath.Join("..", "..", "packages", "setup", "bin", "murmur.mjs"))
	if err != nil || !fileExists(entry) || !fileExists(filepath.Join("..", "..", "packages", "setup", "dist", "src", "cli.js")) {
		t.Skip("node or a built packages/setup is not available")
	}
	root := t.TempDir()
	b := cliBinding{Node: node, Entry: entry}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// A colleague who invites: an ordinary profile of its own.
	inviter := b
	inviter.Profile = filepath.Join(root, "colleague")
	if _, err := runSetupCLI(ctx, inviter, "init", "--agent-id", "agent-colleague", "--broker-url", "nats://127.0.0.1:4222", "--data-dir", inviter.Profile); err != nil {
		t.Fatal(err)
	}
	invite := filepath.Join(root, "murmur-invite.txt")
	if _, err := runSetupCLI(ctx, inviter, "invite", "--out", invite, "--data-dir", inviter.Profile); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(root, "Мой профиль")
	me := b
	me.Profile = profile
	var elevated [][]string
	steps := onboardingSteps{
		pickInvitation: func() (string, bool) { return invite, true },
		pickReply:      func(suggested string) (string, bool) { return suggested, true },
		confirm:        func(_, _ string) bool { return false }, // no service, no client changes
		inform:         func(_, _ string) {},
		revealFile:     func(string) {},
		exists:         fileExists,
		cli:            func(args ...string) ([]byte, error) { return runSetupCLI(ctx, me, args...) },
		elevated:       func(args ...string) error { elevated = append(elevated, args); return nil },
	}
	r, err := runOnboarding(steps, profile, defaultAgentID("Тест User"), root)
	if err != nil {
		t.Fatal(err)
	}
	if !fileExists(filepath.Join(profile, "agent-config.json")) || !fileExists(r.Reply) || len(elevated) != 0 {
		t.Fatalf("profile/reply missing or elevated used: %+v %q", r, elevated)
	}
	// The colleague can import the reply: the pairing file is what the CLI expects.
	out, err := runSetupCLI(ctx, inviter, "add-peer", "--reply-file", r.Reply, "--data-dir", inviter.Profile)
	if err != nil {
		t.Fatal(err)
	}
	var peer struct {
		PeerID string `json:"peerId"`
	}
	if json.Unmarshal(out, &peer) != nil || peer.PeerID != r.AgentID {
		t.Fatalf("add-peer answered %s", out)
	}
	// A failed CLI step reports the CLI's own code, not a generic failure.
	_, err = runSetupCLI(ctx, me, "join", "--agent-id", "agent-x", "--invite-file", filepath.Join(root, "missing.txt"), "--reply-out", filepath.Join(root, "r2.txt"), "--data-dir", filepath.Join(root, "p2"))
	if err == nil || err.Error() != "onboarding.invite-file-not-found" {
		t.Fatalf("want the CLI code, got %v", err)
	}
	_ = os.RemoveAll(root)
}
