package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHomeUsesFiveRowsAndFirstIncompleteStep(t *testing.T) {
	for _, language := range []string{localeEnglish, localeRussian} {
		previous := currentLocale()
		setLocale(language)
		rows, next := homeRows(nil, notConfigured(), "problem")
		if len(rows) != 5 || next.Action != "invite" || rows[0].Action != "setup" {
			t.Fatal(rows, next)
		}
		s := load(t, "status-green.json")
		_, next = homeRows(s, nil, "missing")
		if next.Action != "assistant" {
			t.Fatal(next)
		}
		s.Peers.List = []Peer{}
		_, next = homeRows(s, nil, "missing")
		if next.Action != "invite" {
			t.Fatal(next)
		}
		s.Service.State = "stopped"
		s.Service.Detail = "service.not-installed"
		rows, next = homeRows(s, nil, "missing")
		if rows[1].Action != "install" || next.Action != "install" {
			t.Fatal(rows, next)
		}
		s = load(t, "status-green.json")
		rows, next = homeRows(s, nil, "ready")
		if next.Action != "messages" {
			t.Fatal(next)
		}
		for _, row := range rows {
			if row.Action == "" || strings.Contains(row.Text, "156") || strings.Contains(row.Text, "18232") {
				t.Fatal(row)
			}
		}
		setLocale(previous)
	}
}
func TestInstalledAssistantIsNotAssumedConnected(t *testing.T) {
	profile := t.TempDir()
	for action, want := range map[string]string{"add": "missing", "replace": "missing", "unchanged": "ready"} {
		var commands []string
		got := observeAssistants(func(args ...string) ([]byte, error) {
			commands = append(commands, strings.Join(args, " "))
			if args[1] == "detect" {
				return []byte(`{"schema":"murmur.clients/1","clients":[{"id":"codex-cli","installed":true}]}`), nil
			}
			return json.Marshal(map[string]any{"schema": "murmur.client-plan/1", "client": "codex-cli", "agentId": "fixture", "dataDir": profile, "configPath": profile + "/settings.toml", "action": action, "planId": strings.Repeat("a", 64)})
		}, profile, "fixture")
		if got != want || len(commands) != 2 || strings.Contains(strings.Join(commands, " "), "configure") {
			t.Fatal(got, want, commands)
		}
	}
}

func TestHomeCheckRequiresSuccessfulPrerequisites(t *testing.T) {
	stages := []DoctorStage{{ID: "config", State: "ok"}, {ID: "daemon", State: "ok"}, {ID: "broker", State: "ok"}}
	if !homeCheckReady(&Doctor{Stages: stages}) {
		t.Fatal("complete connection rejected")
	}
	if homeCheckReady(nil) || homeCheckReady(&Doctor{}) || homeCheckReady(&Doctor{Stages: stages[:2]}) {
		t.Fatal("incomplete connection accepted")
	}
	stages[2].State = "skip"
	if homeCheckReady(&Doctor{Stages: stages}) {
		t.Fatal("unmeasured broker accepted")
	}
}
