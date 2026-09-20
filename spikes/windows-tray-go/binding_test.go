package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestTrayInvokesNodeCLIWithExplicitProfile(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	node, _ = filepath.Abs(node)
	dir := t.TempDir()
	entry := filepath.Join(dir, "fake cli.mjs")
	profile := filepath.Join(dir, "profile")
	os.Mkdir(profile, 0700)
	os.WriteFile(entry, []byte(`console.log(JSON.stringify({args:process.argv.slice(2), injection:process.env.NODE_OPTIONS??null, store:process.env.MURMUR_STORE_PATH??null}));`), 0600)
	t.Setenv("MURMUR_BIN", node)
	t.Setenv("MURMUR_CLI", entry)
	t.Setenv("MURMUR_PROFILE", profile)
	t.Setenv("MURMUR_SERVICE_NAME", "ChosenService")
	t.Setenv("NODE_OPTIONS", "--require /not/allowed.js")
	t.Setenv("MURMUR_STORE_PATH", "wrong")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var result struct {
		Args      []string
		Injection *string
		Store     *string
	}
	if err := runJSON(ctx, &result, "status", "--json"); err != nil {
		t.Fatal(err)
	}
	want := []string{"status", "--json", "--data-dir", profile, "--service-name", "ChosenService"}
	if len(result.Args) != len(want) {
		t.Fatalf("argv=%q", result.Args)
	}
	for i := range want {
		if result.Args[i] != want[i] {
			t.Fatalf("argv=%q", result.Args)
		}
	}
	if result.Injection != nil || result.Store != nil {
		t.Fatal("ambient injection inherited")
	}
}

func TestPinnedIdentityCannotBecomeAnotherAgent(t *testing.T) {
	s := &Status{Schema: statusSchema, GeneratedAt: time.Now().UTC().Format(time.RFC3339), AgentID: "alice"}
	if err := validatePinnedStatus(s, "alice"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"bob", ""} {
		s.AgentID = id
		if validatePinnedStatus(s, "alice") == nil {
			t.Fatalf("accepted %q", id)
		}
	}
	s.AgentID = "alice"
	for _, offset := range []time.Duration{-5 * time.Minute, time.Hour} {
		s.GeneratedAt = time.Now().Add(offset).UTC().Format(time.RFC3339)
		if validatePinnedStatus(s, "alice") == nil {
			t.Fatal("accepted stale/future snapshot")
		}
	}
}
func TestActionResponseMustMatchRequestedOperation(t *testing.T) {
	for _, tc := range []struct {
		body, command, action string
		ok                    bool
	}{
		{`{"schema":"murmur.service/1","action":"start"}`, "service", "start", true},
		{`{"schema":"murmur.service/1","action":"stop"}`, "service", "start", false},
		{`{"schema":"murmur.wake/1","configuredEnabled":false}`, "wake", "pause", true},
		{`{"schema":"murmur.wake/1","configuredEnabled":null}`, "wake", "pause", false},
		{`{"schema":"murmur.wake/1","configuredEnabled":true}`, "wake", "pause", false},
		{`{}`, "service", "start", false},
	} {
		if (validateAction([]byte(tc.body), tc.command, tc.action) == nil) != tc.ok {
			t.Fatal(tc.body)
		}
	}
}
func TestTraySchemaGrammarRejectsMalformedVersions(t *testing.T) {
	for _, s := range []string{"murmur.status/01", "murmur.status/+1", "murmur.status/1.", "murmur.status/1.beta", "murmur.status/1.2.3"} {
		if schemaKnown(s, statusSchema) {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"murmur.status/1", "murmur.status/1.4"} {
		if !schemaKnown(s, statusSchema) {
			t.Fatal(s)
		}
	}
}
