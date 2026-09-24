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

func TestPairingRejectsInvalidInputBeforeMutation(t *testing.T) {
	for _, line := range []string{"", "missing-prefix", "MURMUR:", "MURMUR:first\nMURMUR:second", "MURMUR:" + strings.Repeat("a", pairingMaxBytes)} {
		calls := 0
		_, err := importReply(func(...string) ([]byte, error) { calls++; return nil, nil }, func(string, ...string) ([]byte, error) { calls++; return nil, nil }, "fixture", line)
		if err == nil || calls != 0 {
			t.Fatal("invalid input reached engine")
		}
	}
	if got, err := pairingLine("  MURMUR:synthetic  "); err != nil || got != "MURMUR:synthetic" {
		t.Fatal("surrounding whitespace rejected")
	}
}
func TestPairingLineTakesTheTokenOutOfMessengerText(t *testing.T) {
	token := "MURMUR:eyJ2IjoxLCJ0eXBlIjoiaW52aXRlIn0"
	for _, pasted := range []string{
		token + "\n\n\u2191 Copy only the MURMUR: line above.\n\n\u2593\u2592\u2591 signature",
		"Here is the invitation: \u00ab" + token + "\u00bb",
		"```\n" + token + "\n```",
		"\t" + token + "==\r\n",
	} {
		got, err := pairingLine(pasted)
		if err != nil || !strings.HasPrefix(got, token) {
			t.Fatalf("token not taken from %q: %q %v", pasted, got, err)
		}
	}
	for _, pasted := range []string{
		"only the prefix MURMUR: is mentioned",
		token + "\n" + token,
		"MURMUR:\u00bb",
	} {
		if _, err := pairingLine(pasted); err == nil {
			t.Fatalf("accepted %q", pasted)
		}
	}
}
func TestPairingFileFallbackIsBounded(t *testing.T) {
	p := filepath.Join(t.TempDir(), "invitation.txt")
	os.WriteFile(p, []byte("MURMUR:synthetic\n"), 0600)
	if got, err := pairingFile(p); err != nil || got != "MURMUR:synthetic" {
		t.Fatal("valid fallback rejected")
	}
	os.WriteFile(p, []byte("MURMUR:"+strings.Repeat("a", pairingMaxBytes)), 0600)
	if _, err := pairingFile(p); err == nil {
		t.Fatal("oversized file accepted")
	}
}
func TestPairingErrorsDoNotExposeLineOrCodes(t *testing.T) {
	for _, language := range []string{localeEnglish, localeRussian} {
		previous := currentLocale()
		setLocale(language)
		for _, value := range []string{"onboarding.invalid-blob", "onboarding.self-peer", "onboarding.existing-profile-conflict", "MURMUR:secret\nprivate-data"} {
			for _, reply := range []bool{true, false} {
				message := pairingError(errors.New(value), reply)
				if strings.Contains(message, "onboarding.") || strings.Contains(message, "secret") || strings.Contains(message, "private-data") {
					t.Fatal("unsafe error")
				}
			}
		}
		setLocale(previous)
	}
}
func TestPairingPendingStepSurvivesLocaleAndGuideChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preferences.json")
	profile := filepath.Join(t.TempDir(), "profile")
	if err := savePendingReplyPreference(path, profile, "fixture", true); err != nil {
		t.Fatal(err)
	}
	saveLocalePreference(path, localeRussian)
	saveGuideSeenPreference(path)
	if !pendingReplyPreference(path, profile, "fixture") || pendingReplyPreference(path, profile, "other") {
		t.Fatal("pending step lost or identity not bound")
	}
	savePendingReplyPreference(path, profile, "other", false)
	if !pendingReplyPreference(path, profile, "fixture") {
		t.Fatal("unrelated Identity cleared pending")
	}
	savePendingReplyPreference(path, profile, "fixture", false)
	if pendingReplyPreference(path, profile, "fixture") {
		t.Fatal("pending step not cleared")
	}
}
func TestJoinReceiptMustMatchIdentity(t *testing.T) {
	if _, err := joinReply([]byte(`{"schema":"murmur.join/1","agentId":"other","peerId":"colleague","reply":"MURMUR:reply"}`), "fixture"); err == nil {
		t.Fatal("wrong Identity accepted")
	}
}

func TestReplyImportBindsIdentityAndConfirmsReadback(t *testing.T) {
	for _, mode := range []string{"ok", "wrong-identity", "bad-ack", "missing-contact", "changed-after"} {
		t.Run(mode, func(t *testing.T) {
			s := load(t, "status-green.json")
			identity := s.AgentID
			peer := s.Peers.List[0].AgentID
			calls := []string{}
			writes := 0
			cli := func(args ...string) ([]byte, error) {
				calls = append(calls, strings.Join(args, " "))
				if mode == "wrong-identity" || (mode == "changed-after" && writes > 0) {
					s.AgentID = "unexpected"
				}
				if mode == "missing-contact" && writes > 0 {
					s.Peers.List = []Peer{}
				}
				return json.Marshal(s)
			}
			input := func(line string, args ...string) ([]byte, error) {
				writes++
				calls = append(calls, strings.Join(args, " "))
				if line != "MURMUR:synthetic" {
					t.Fatal("wrong stdin")
				}
				if mode == "bad-ack" {
					return []byte(`{}`), nil
				}
				return json.Marshal(map[string]string{"schema": "murmur.peer/1", "peerId": peer})
			}
			got, err := importReply(cli, input, identity, "MURMUR:synthetic")
			if mode == "ok" {
				if err != nil || got != peer || !reflect.DeepEqual(calls, []string{"status --json", "add-peer --reply-stdin --json", "status --json"}) {
					t.Fatal("unexpected exchange order", calls, err)
				}
			} else if err == nil {
				t.Fatal("unconfirmed contact accepted")
			}
			if mode == "wrong-identity" && writes != 0 {
				t.Fatal("wrong Identity mutated")
			}
		})
	}
}
