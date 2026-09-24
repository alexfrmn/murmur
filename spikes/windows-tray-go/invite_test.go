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

func TestCreateInviterOrderAndCredentialLifetime(t *testing.T) {
	for _, fail := range []string{"", "init", "cleanup", "install", "start", "response"} {
		t.Run(fail, func(t *testing.T) {
			events := []string{}
			tokenExists := false
			s := inviteSteps{
				token: func(value string) (string, func() error, error) {
					if value != "synthetic-secret" {
						t.Fatal("wrong token")
					}
					tokenExists = true
					events = append(events, "token")
					return "private-key", func() error {
						events = append(events, "cleanup")
						tokenExists = false
						if fail == "cleanup" {
							return errors.New("remove")
						}
						return nil
					}, nil
				},
				cli: func(args ...string) ([]byte, error) {
					events = append(events, "init")
					if !tokenExists {
						t.Fatal("key removed too soon")
					}
					if strings.Contains(strings.Join(args, " "), "synthetic-secret") {
						t.Fatal("credential in argv")
					}
					if !reflect.DeepEqual(args, []string{"init", "--agent-id", "PC", "--broker-url", "nats://example.org:4222", "--data-dir", "profile", "--json", "--token-file", "private-key"}) {
						t.Fatalf("args %q", args)
					}
					if fail == "init" {
						return nil, errors.New("init")
					}
					if fail == "response" {
						return []byte(`{"schema":"wrong"}`), nil
					}
					return []byte(`{"schema":"murmur.init/1","agentId":"PC","dataDir":"profile"}`), nil
				},
				service: func(args ...string) error {
					if tokenExists {
						t.Fatal("credential survived init")
					}
					events = append(events, args[1])
					if args[1] == fail {
						return errors.New(fail)
					}
					return nil
				},
			}
			err := createInviter(s, inviteIdentity{"PC", "nats://example.org:4222", "synthetic-secret"}, "profile")
			if (err == nil) != (fail == "") {
				t.Fatalf("error=%v", err)
			}
			want := []string{"token", "init", "cleanup"}
			if fail == "" || fail == "install" || fail == "start" {
				want = append(want, "install")
			}
			if fail == "" || fail == "start" {
				want = append(want, "start")
			}
			if !reflect.DeepEqual(events, want) {
				t.Fatalf("events %v want %v", events, want)
			}
		})
	}
}

func TestCreateInviterRejectsCredentialsInServerAddress(t *testing.T) {
	for _, address := range []string{"nats://synthetic-secret@example.org:4222", "nats://example.org:4222?token=synthetic-secret"} {
		// Nil actions also prove no command or temporary file is created.
		if err := createInviter(inviteSteps{}, inviteIdentity{Name: "PC", Server: address}, "profile"); err == nil {
			t.Fatal("accepted credentials in command-line address")
		}
	}
}

func TestInvitePublicAddressRetry(t *testing.T) {
	base := []string{"invite", "--out", "backup", "--json"}
	calls := [][]string{}
	out, err := inviteWithPublicServer(func(args ...string) ([]byte, error) {
		calls = append(calls, append([]string(nil), args...))
		if len(calls) == 1 {
			return nil, errors.New("onboarding.invite-public-server-required")
		}
		return []byte("success"), nil
	}, base, func(err error) (string, bool) {
		if err.Error() != "onboarding.invite-public-server-required" {
			t.Fatal(err)
		}
		return " public.example.org:4222 ", true
	})
	if err != nil || string(out) != "success" {
		t.Fatalf("result %s %v", out, err)
	}
	if len(calls) != 2 || !reflect.DeepEqual(calls[0], base) || !reflect.DeepEqual(calls[1], append(append([]string(nil), base...), "--broker", "nats://public.example.org:4222")) {
		t.Fatalf("calls %v", calls)
	}
}

func TestInvitePublicAddressCancelAndUnsafeAddress(t *testing.T) {
	for _, tc := range []struct {
		address string
		ok      bool
	}{{"", false}, {"nats://synthetic-secret@example.org:4222", true}} {
		calls := 0
		_, err := inviteWithPublicServer(func(...string) ([]byte, error) {
			calls++
			return nil, errors.New("onboarding.invite-public-server-required")
		}, []string{"invite"}, func(error) (string, bool) { return tc.address, tc.ok })
		if err == nil || calls != 1 {
			t.Fatalf("unexpected retry: %d %v", calls, err)
		}
		if !tc.ok && !errors.Is(err, errOnboardingCancelled) {
			t.Fatal(err)
		}
	}
}

func TestInvitationContentRefusesUntrustedOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "invite.txt")
	for _, tc := range []struct {
		name, content, schema, file string
		credential                  any
		valid                       bool
	}{
		{"valid", "MURMUR:synthetic\n", "murmur.invite/1", path, false, true},
		{"credential", "MURMUR:synthetic", "murmur.invite/1", path, true, true},
		{"missing-flag", "MURMUR:synthetic", "murmur.invite/1", path, nil, false},
		{"wrong-path", "MURMUR:synthetic", "murmur.invite/1", path + "other", false, false},
		{"wrong-schema", "MURMUR:synthetic", "unknown", path, false, false},
		{"oversized", "MURMUR:" + strings.Repeat("a", 8192), "murmur.invite/1", path, false, false},
		{"multiline", "MURMUR:a\nMURMUR:b", "murmur.invite/1", path, false, false},
		{"empty-payload", "MURMUR:", "murmur.invite/1", path, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(tc.content), 0600); err != nil {
				t.Fatal(err)
			}
			out, _ := json.Marshal(map[string]any{"schema": tc.schema, "file": tc.file, "containsBrokerCredential": tc.credential})
			_, credential, err := invitationContent(out, path)
			if (err == nil) != tc.valid {
				t.Fatalf("err=%v", err)
			}
			if tc.valid && credential != tc.credential {
				t.Fatal("credential flag lost")
			}
		})
	}
}
