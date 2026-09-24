package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// inviteBackupDir is where the tray keeps the private backup copy of an
// Invitation. The engine refuses to write it inside the profile it belongs to
// (onboarding.output-inside-profile), so the folder sits next to the profile.
func inviteBackupDir(profile string) string {
	profile = filepath.Clean(profile)
	return filepath.Join(filepath.Dir(profile), filepath.Base(profile)+" invitations")
}

type inviteIdentity struct{ Name, Server, Token string }
type inviteSteps struct {
	cli     func(...string) ([]byte, error)
	service func(...string) error
	token   func(string) (string, func() error, error)
}

// A public alias is an invitation override, not a rewrite of the local Service.
// Retry only after the user supplies an address; cancellation never invokes CLI.
func inviteWithPublicServer(cli func(...string) ([]byte, error), args []string, ask func(error) (string, bool)) ([]byte, error) {
	base := append([]string(nil), args...)
	for {
		out, err := cli(args...)
		if err == nil {
			return out, nil
		}
		if err.Error() != "onboarding.invite-public-server-required" && err.Error() != "onboarding.invite-server-address-invalid" {
			return nil, err
		}
		address, ok := ask(err)
		if !ok {
			return nil, errOnboardingCancelled
		}
		address = normalizeInviteServer(address)
		server, parseErr := url.Parse(address)
		if parseErr != nil || server.User != nil || server.RawQuery != "" || server.Fragment != "" {
			return nil, errors.New("onboarding.invite-server-address-invalid")
		}
		args = append(append([]string(nil), base...), "--broker", address)
	}
}

func normalizeInviteServer(address string) string {
	address = strings.TrimSpace(address)
	if !strings.Contains(address, "://") {
		address = "nats://" + address
	}
	return address
}

// The engine owns creation and service configuration. Stop on the first failure;
// in particular, remove the credential file before installing a service.
func createInviter(s inviteSteps, input inviteIdentity, profile string) error {
	server, parseErr := url.Parse(input.Server)
	if parseErr != nil || server.User != nil || server.RawQuery != "" || server.Fragment != "" {
		return errors.New("onboarding.invite-server-address-invalid")
	}
	args := []string{"init", "--agent-id", input.Name, "--broker-url", input.Server, "--data-dir", profile, "--json"}
	cleanup := func() error { return nil }
	if input.Token != "" {
		path, remove, err := s.token(input.Token)
		if err != nil {
			return fmt.Errorf("token: %w", err)
		}
		cleanup = remove
		args = append(args, "--token-file", path)
	}
	out, err := s.cli(args...)
	removeErr := cleanup()
	if removeErr != nil {
		return errors.New("token-cleanup-failed")
	}
	if err != nil {
		return fmt.Errorf("init: %w", err)
	}
	var result struct{ Schema, AgentID, DataDir string }
	if json.Unmarshal(out, &result) != nil || result.Schema != "murmur.init/1" || result.AgentID != input.Name || result.DataDir != profile {
		return errors.New("init-response-invalid")
	}
	for _, action := range []string{"install", "start"} {
		if err := s.service("service", action, "--data-dir", profile, "--json"); err != nil {
			return fmt.Errorf("service-%s: %w", action, err)
		}
	}
	return nil
}

func invitationContent(out []byte, path string) (string, bool, error) {
	var r struct {
		Schema, File             string
		ContainsBrokerCredential *bool
	}
	if json.Unmarshal(out, &r) != nil || r.Schema != "murmur.invite/1" || r.File != path || r.ContainsBrokerCredential == nil {
		return "", false, errors.New("invite-response-invalid")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", false, errors.New("invite-file-invalid")
	}
	content, err := io.ReadAll(io.LimitReader(f, 8193))
	line := strings.TrimSpace(string(content))
	if err != nil || len(content) > 8192 || !strings.HasPrefix(line, "MURMUR:") || len(line) <= len("MURMUR:") || strings.ContainsAny(line, "\r\n\t ") {
		return "", false, errors.New("invite-file-invalid")
	}
	return line, *r.ContainsBrokerCredential, nil
}
