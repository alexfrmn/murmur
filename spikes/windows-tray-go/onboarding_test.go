package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fakeOnboarding struct {
	cancelInvite, cancelReply bool
	replyNames                []string // successive answers of the save dialog
	existing                  map[string]bool
	answers                   []bool // successive confirm answers
	cliCalls, elevatedCalls   [][]string
	detect                    string
	failJoin, failElevated    bool
	informed, revealed        []string
}

func (f *fakeOnboarding) steps() onboardingSteps {
	return onboardingSteps{
		pickInvitation: func() (string, bool) { return `C:\Users\me\Downloads\murmur-invite.txt`, !f.cancelInvite },
		pickReply: func(suggested string) (string, bool) {
			if f.cancelReply {
				return "", false
			}
			if len(f.replyNames) == 0 {
				return suggested, true
			}
			name := f.replyNames[0]
			f.replyNames = f.replyNames[1:]
			return name, true
		},
		confirm: func(_, _ string) bool {
			if len(f.answers) == 0 {
				return false
			}
			answer := f.answers[0]
			f.answers = f.answers[1:]
			return answer
		},
		inform:     func(_, text string) { f.informed = append(f.informed, text) },
		revealFile: func(path string) { f.revealed = append(f.revealed, path) },
		cli: func(args ...string) ([]byte, error) {
			f.cliCalls = append(f.cliCalls, args)
			if args[0] == "join" && f.failJoin {
				return nil, errors.New("onboarding.invite-file-access-denied")
			}
			if args[0] == "clients" && args[1] == "detect" {
				return []byte(f.detect), nil
			}
			if args[0] == "clients" && (args[1] == "preview" || args[1] == "configure") {
				schema := "murmur.client-plan/1"
				if args[1] == "configure" {
					schema = "murmur.client/1"
				}
				return json.Marshal(map[string]any{"schema": schema, "client": args[3], "dataDir": args[5], "agentId": "agent-me", "configPath": filepath.Join(os.TempDir(), "fake-assistant.json"), "planId": strings.Repeat("a", 64), "action": "add", "changed": true})
			}
			return []byte(`{}`), nil
		},
		elevated: func(args ...string) error {
			f.elevatedCalls = append(f.elevatedCalls, args)
			if f.failElevated {
				return errors.New("declined")
			}
			return nil
		},
		exists: func(path string) bool { return f.existing[path] },
	}
}

var profile, replyDir = filepath.Join(os.TempDir(), "murmur-fake-onboarding-profile"), filepath.Join(os.TempDir(), "murmur-fake-onboarding-replies")

func TestDefaultAgentIDIsValidAndReadable(t *testing.T) {
	for in, want := range map[string]string{"vasil": "agent-vasil", "Иван Петров": "agent-user", "John.Smith": "agent-john-smith", "": "agent-user", "__x__": "agent-x"} {
		if got := defaultAgentID(in); got != want {
			t.Errorf("defaultAgentID(%q) = %q, want %q", in, got, want)
		}
	}
	if got := defaultAgentID(strings.Repeat("a", 90)); len(got) > 128 || !strings.HasPrefix(got, "agent-") {
		t.Errorf("long name %q", got)
	}
}

func TestOnboardingJoinsInstallsTheServiceAndConnectsDetectedClients(t *testing.T) {
	f := &fakeOnboarding{answers: []bool{true, true},
		detect: `{"schema":"murmur.clients/1","clients":[{"id":"claude-code","installed":true},{"id":"codex-cli","installed":true},{"id":"other","installed":true}]}`}
	r, err := runOnboarding(f.steps(), profile, "agent-me", replyDir)
	if err != nil {
		t.Fatal(err)
	}
	reply := filepath.Join(replyDir, "murmur-reply-agent-me.txt")
	wantCLI := [][]string{
		{"join", "--agent-id", "agent-me", "--invite-file", `C:\Users\me\Downloads\murmur-invite.txt`, "--reply-out", reply, "--data-dir", profile},
		{"clients", "detect", "--data-dir", profile},
		{"clients", "preview", "--client", "claude-code", "--data-dir", profile, "--json"},
		{"clients", "configure", "--client", "claude-code", "--data-dir", profile, "--plan-id", strings.Repeat("a", 64), "--json"},
		{"clients", "preview", "--client", "codex-cli", "--data-dir", profile, "--json"},
		{"clients", "configure", "--client", "codex-cli", "--data-dir", profile, "--plan-id", strings.Repeat("a", 64), "--json"},
	}
	if !reflect.DeepEqual(f.cliCalls, wantCLI) {
		t.Fatalf("cli calls\n got %q\nwant %q", f.cliCalls, wantCLI)
	}
	if !reflect.DeepEqual(f.elevatedCalls, [][]string{{"service", "install", "--json", "--data-dir", profile}}) {
		t.Fatalf("elevated calls %q", f.elevatedCalls)
	}
	if !reflect.DeepEqual(f.revealed, []string{reply}) || !r.ServiceInstalled || !reflect.DeepEqual(r.Clients, []string{"Claude Code", "Codex"}) {
		t.Fatalf("result %+v revealed %q", r, f.revealed)
	}
}

func TestOnboardingCancelsWithoutTouchingAnything(t *testing.T) {
	for _, f := range []*fakeOnboarding{{cancelInvite: true}, {cancelReply: true}} {
		if _, err := runOnboarding(f.steps(), profile, "agent-me", replyDir); !errors.Is(err, errOnboardingCancelled) {
			t.Fatalf("want cancelled, got %v", err)
		}
		if len(f.cliCalls) != 0 || len(f.elevatedCalls) != 0 {
			t.Fatalf("cancel must not run anything: %q %q", f.cliCalls, f.elevatedCalls)
		}
	}
}

func TestOnboardingAsksForAnotherReplyNameInsteadOfOverwriting(t *testing.T) {
	taken := filepath.Join(replyDir, "murmur-reply-agent-me.txt")
	f := &fakeOnboarding{existing: map[string]bool{taken: true}, replyNames: []string{taken, `C:\Users\me\Desktop\reply-2.txt`}}
	r, err := runOnboarding(f.steps(), profile, "agent-me", replyDir)
	if err != nil || r.Reply != `C:\Users\me\Desktop\reply-2.txt` || len(f.informed) < 2 {
		t.Fatalf("reply %q err %v informed %q", r.Reply, err, f.informed)
	}
}

func TestOnboardingStopsOnAFailedJoinAndReportsDeclinedSteps(t *testing.T) {
	f := &fakeOnboarding{failJoin: true}
	if _, err := runOnboarding(f.steps(), profile, "agent-me", replyDir); err == nil || !strings.Contains(err.Error(), "onboarding.invite-file-access-denied") {
		t.Fatalf("join failure must be reported with its code, got %v", err)
	}
	if len(f.elevatedCalls) != 0 || len(f.cliCalls) != 1 {
		t.Fatalf("nothing after a failed join: %q %q", f.cliCalls, f.elevatedCalls)
	}
	// Service declined, clients declined: the profile stays, nothing elevated, nothing configured.
	g := &fakeOnboarding{answers: []bool{false, false}, detect: `{"schema":"murmur.clients/1","clients":[{"id":"claude-code","installed":true}]}`}
	r, err := runOnboarding(g.steps(), profile, "agent-me", replyDir)
	if err != nil || r.ServiceInstalled || len(r.Clients) != 0 || len(g.elevatedCalls) != 0 {
		t.Fatalf("declined steps: %+v %v %q", r, err, g.elevatedCalls)
	}
	// A declined or failed UAC prompt is told, and client setup is still offered.
	h := &fakeOnboarding{answers: []bool{true, true}, failElevated: true, detect: `{"schema":"murmur.clients/1","clients":[{"id":"codex-cli","installed":true}]}`}
	r, err = runOnboarding(h.steps(), profile, "agent-me", replyDir)
	if err != nil || r.ServiceInstalled || !reflect.DeepEqual(r.Clients, []string{"Codex"}) {
		t.Fatalf("failed service: %+v %v", r, err)
	}
}
