package main

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAssistantConflictRequiresExactPlanAndConsent(t *testing.T) {
	for _, tc := range []struct {
		name, action, hook string
		accept             bool
		wantCalls          int
		wantReplace        bool
	}{
		{"replace accepted", "replace", "", true, 2, true},
		{"replace declined", "replace", "", false, 1, false},
		{"wake conflict accepted", "unchanged", "replace", true, 2, true},
		{"wake conflict declined", "add", "replace", false, 1, false},
		{"new entry", "add", "", false, 2, false},
		{"already connected", "unchanged", "unchanged", false, 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "assistant.json")
			planID := strings.Repeat("a", 64)
			plan := map[string]any{"schema": "murmur.client-plan/1", "client": "claude-code", "dataDir": root, "agentId": "new-identity", "configPath": target, "action": tc.action, "planId": planID}
			if tc.hook != "" {
				plan["wakeHook"] = map[string]string{"action": tc.hook}
			}
			calls := [][]string{}
			confirmations := 0
			s := onboardingSteps{
				confirmClientReplacement: func(name, identity string) bool {
					confirmations++
					if name != "Claude Code" || identity != "new-identity" {
						t.Fatal("confirmation omits target")
					}
					return tc.accept
				},
				cli: func(args ...string) ([]byte, error) {
					calls = append(calls, args)
					if args[1] == "preview" {
						return json.Marshal(plan)
					}
					result := map[string]any{"schema": "murmur.client/1", "client": "claude-code", "dataDir": root, "agentId": "new-identity", "configPath": target, "planId": planID, "changed": true}
					return json.Marshal(result)
				},
			}
			err := configureAssistant(s, "claude-code", root, "new-identity")
			if len(calls) != tc.wantCalls {
				t.Fatalf("calls %v", calls)
			}
			conflict := tc.action == "replace" || tc.hook == "replace"
			if conflict && !tc.accept {
				if !errors.Is(err, errOnboardingCancelled) {
					t.Fatal(err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if (confirmations == 1) != conflict {
				t.Fatalf("confirmations %d", confirmations)
			}
			if len(calls) == 2 {
				want := []string{"clients", "configure", "--client", "claude-code", "--data-dir", root, "--plan-id", planID, "--json"}
				if tc.wantReplace {
					want = append(want, "--replace")
				}
				if !reflect.DeepEqual(calls[1], want) {
					t.Fatalf("configure %v want %v", calls[1], want)
				}
			}
		})
	}
}

func TestAssistantRejectsUnboundPreviewAndStalePlan(t *testing.T) {
	for _, field := range []string{"schema", "client", "dataDir", "agentId", "configPath", "planId", "action", "stale", "result"} {
		t.Run(field, func(t *testing.T) {
			root := t.TempDir()
			plan := map[string]any{"schema": "murmur.client-plan/1", "client": "codex-cli", "dataDir": root, "agentId": "me", "configPath": filepath.Join(root, "config.toml"), "action": "replace", "planId": strings.Repeat("b", 64)}
			if field != "stale" && field != "result" {
				plan[field] = "invalid"
			}
			calls := 0
			s := onboardingSteps{confirm: func(string, string) bool { return true }, cli: func(args ...string) ([]byte, error) {
				calls++
				if args[1] == "preview" {
					return json.Marshal(plan)
				}
				if field == "stale" {
					return nil, errors.New("client.plan-stale")
				}
				return []byte(`{}`), nil
			}}
			err := configureAssistant(s, "codex-cli", root, "me")
			if err == nil {
				t.Fatal("invalid response accepted")
			}
			wantCalls := 1
			if field == "stale" || field == "result" {
				wantCalls = 2
			}
			if calls != wantCalls {
				t.Fatalf("unexpected retry/configure %d", calls)
			}
			if field == "stale" && err.Error() != "client.plan-stale" {
				t.Fatal(err)
			}
		})
	}
}

func TestAssistantSelectionCannotConfigureDesktopOrUnknownClients(t *testing.T) {
	calls := 0
	choiceShown := false
	s := onboardingSteps{
		cli: func(args ...string) ([]byte, error) {
			calls++
			return []byte(`{"schema":"murmur.clients/1","clients":[{"id":"claude-code","installed":true},{"id":"claude-desktop","installed":true}]}`), nil
		},
		chooseClients: func(found []string) []string {
			choiceShown = true
			if !reflect.DeepEqual(found, []string{"claude-code"}) {
				t.Fatal(found)
			}
			return []string{"claude-desktop", "unknown"}
		},
		inform: func(string, string) {},
	}
	if connected := connectAssistants(s, t.TempDir(), "me"); len(connected) != 0 || calls != 1 || !choiceShown {
		t.Fatalf("connected %v calls %d", connected, calls)
	}
}

func TestAssistantErrorsAreLocalizedWithoutRawCLIText(t *testing.T) {
	defer setLocale(currentLocale())
	for _, locale := range []string{localeEnglish, localeRussian} {
		setLocale(locale)
		for _, code := range []string{"client.plan-stale", "client.wake-hook-conflict", "client.not-detected", "client.config-path-unverified", "synthetic secret=value"} {
			message := assistantFailure(errors.New(code))
			if message == "" || strings.Contains(message, code) || strings.Contains(message, "secret=value") {
				t.Fatalf("raw or missing error %q", message)
			}
		}
		if !strings.Contains(tr("assistants.desktopUnsupported"), "Claude Desktop") {
			t.Fatal("missing Desktop disclosure")
		}
	}
}
