package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func inboxFixture(identity string) []byte {
	return []byte(`{"schema":"murmur.inbox/1","agentId":"` + identity + `","unread":2,"messages":[{"sender":"colleague","createdAt":"2026-09-24T09:00:00Z","text":"hello","assistantRead":false,"unread":true}]}`)
}
func statusBytes(t *testing.T, identity string) []byte {
	s := load(t, "status-green.json")
	s.AgentID = identity
	out, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestMessagesReadNeverMarksAndExplicitMarkRefreshes(t *testing.T) {
	for _, mark := range []bool{false, true} {
		var calls []string
		cli := func(args ...string) ([]byte, error) {
			calls = append(calls, strings.Join(args, " "))
			switch args[0] + " " + args[1] {
			case "status --json":
				return statusBytes(t, "fixture"), nil
			case "inbox mark-read":
				return []byte(`{"schema":"murmur.read/1","agentId":"fixture","rowid":7}`), nil
			default:
				return inboxFixture("fixture"), nil
			}
		}
		v, err := readMessages(cli, "fixture", mark)
		if err != nil || v.Messages[0].AssistantRead == nil || *v.Messages[0].AssistantRead {
			t.Fatalf("Assistant read was fabricated: %#v %v", v, err)
		}
		want := "status --json|inbox read --limit 20 --json"
		if mark {
			want = "status --json|inbox mark-read --json|inbox read --limit 20 --json"
		}
		if strings.Join(calls, "|") != want {
			t.Fatal(calls)
		}
	}
}

func TestMessagesChangedIdentityRefusesBeforeReadCursorWrite(t *testing.T) {
	calls := 0
	_, err := readMessages(func(args ...string) ([]byte, error) { calls++; return statusBytes(t, "other"), nil }, "fixture", true)
	if err == nil || calls != 1 {
		t.Fatalf("mutation not refused: calls=%d err=%v", calls, err)
	}
}

func TestMessagesRejectsMissingTriStateAndWrongAcknowledgement(t *testing.T) {
	for _, bad := range []string{
		strings.Replace(string(inboxFixture("fixture")), `"assistantRead":false,`, "", 1),
		strings.Replace(string(inboxFixture("fixture")), `"text":"hello"`, `"text":null`, 1),
		string(inboxFixture("other")),
		`{"schema":"murmur.inbox/1","agentId":"fixture","messages":null}`,
	} {
		if _, err := parseInbox([]byte(bad), "fixture"); err == nil {
			t.Fatal("invalid inbox accepted", bad)
		}
	}
	calls := 0
	_, err := readMessages(func(args ...string) ([]byte, error) {
		calls++
		if args[0] == "status" {
			return statusBytes(t, "fixture"), nil
		}
		return []byte(`{"schema":"murmur.read/1","agentId":"other","rowid":7}`), nil
	}, "fixture", true)
	if err == nil || calls != 2 {
		t.Fatal("wrong write acknowledgement accepted", calls, err)
	}
}

func TestMessageColumnsKeepUnknownSeparateAndUseLocalTime(t *testing.T) {
	old := time.Local
	time.Local = time.FixedZone("fixture", 3*3600)
	t.Cleanup(func() { time.Local = old })
	locale := currentLocale()
	t.Cleanup(func() { setLocale(locale) })
	for _, language := range []string{localeEnglish, localeRussian} {
		setLocale(language)
		v, _ := parseInbox(inboxFixture("fixture"), "fixture")
		m := v.Messages[0]
		m.AssistantRead = nil
		m.Text = strings.Repeat("Я", 121) + "\x00\n"
		m.Sender = "colleague\u202e\n"
		cols := messageColumns(m)
		if cols[0] != "colleague" || cols[1] != "24.09.2026 12:00" || cols[2] != tr("messages.unmeasured") || len([]rune(cols[3])) != 121 || !strings.HasSuffix(cols[3], "…") {
			t.Fatal(cols)
		}
		for _, read := range []bool{false, true} {
			m.AssistantRead = &read
			if got := messageColumns(m)[2]; got != boolText(&read) {
				t.Fatal(got)
			}
		}
	}
}
