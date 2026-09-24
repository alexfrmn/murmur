//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	inviteSchema      = "murmur.invite/1"
	inviteMaxFileSize = 8192
	invitePrefix      = "MURMUR:"
)

// inviteColleague creates an invitation for a colleague: murmur invite --out <temp file> --json,
// confirms if the invitation contains broker credentials (PRD R3 variant b), then copies the
// MURMUR:... line to the clipboard. The file stays as a fallback.
//
// Codex-Win calls this via firstRunActions.InviteColleague = a.inviteColleague.
func (a *app) inviteColleague() {
	a.mu.Lock()
	if a.actionBusy {
		a.mu.Unlock()
		return
	}
	a.actionBusy = true
	expected := a.pinnedAgent
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.actionBusy = false; a.mu.Unlock(); a.refreshStatus() }()

	b, err := selectedCLI()
	if err != nil {
		var se *statusError
		if !errors.As(err, &se) || se.code != "profile.not-configured" {
			a.inviteError("invite.noRuntime", "runtime-unavailable")
			return
		}
	}
	if !isProfile(b.Profile) {
		input, ok := showInviteIdentity()
		if !ok {
			return
		}
		profile := b.Profile
		if profile == "" {
			profile = filepath.Join(os.Getenv("LOCALAPPDATA"), "Murmur")
		}
		if !filepath.IsAbs(profile) {
			a.inviteError("invite.failed", "profile-path-invalid")
			return
		}
		if b.Node == "" || b.Entry == "" {
			b, err = setupBinding(profile)
		} else {
			b.Profile = profile
			err = nil
		}
		if err != nil {
			a.inviteError("invite.noRuntime", "runtime-unavailable")
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		steps := inviteSteps{
			token: privateInviteToken,
			cli:   func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, args...) },
			service: func(args ...string) error {
				if !serviceAdmin() {
					return runElevated(ctx, b.Node, append([]string{b.Entry}, args...), filepath.Dir(b.Entry))
				}
				out, err := runSetupCLI(ctx, b, args...)
				if err == nil {
					err = validateAction(out, "service", args[1])
				}
				return err
			},
		}
		err = createInviter(steps, input, profile)
		cancel()
		if err != nil {
			a.inviteError("invite.createFailed", safeInviteCode(err))
			return
		}
		expected = input.Name
	}

	ctx, cancel := context.WithTimeout(context.Background(), mutationTimeout)
	defer cancel()

	// Verify identity first
	statusOut, err := runSetupCLI(ctx, b, "status", "--data-dir", b.Profile, "--json")
	var fresh *Status
	if err == nil {
		fresh, err = parseStatus(statusOut)
	}
	if err == nil {
		err = validatePinnedStatus(fresh, expected)
	}
	if err != nil {
		a.inviteError("invite.identityFailed", "identity-unconfirmed")
		return
	}

	// Create invitation in a private location inside the profile with unique name (P1)
	inviteDir := filepath.Join(b.Profile, "invites")
	if err := os.MkdirAll(inviteDir, 0o700); err != nil {
		a.inviteError("invite.folderFailed", "output-folder-failed")
		return
	}
	// Unique filename avoids O_EXCL collision on repeat invitations
	inviteFile := filepath.Join(inviteDir, fmt.Sprintf("invite-%d.txt", time.Now().UnixNano()))

	out, err := runSetupCLI(ctx, b, "invite", "--out", inviteFile, "--data-dir", b.Profile, "--json")
	if err != nil {
		errStr := err.Error()
		// Check for specific error codes with localized messages
		switch {
		case strings.Contains(errStr, "onboarding.invite-public-server-required"):
			a.inviteError("invite.publicServerRequired", "onboarding.invite-public-server-required")
		default:
			// P2/R8: safe fallback without raw error in UI
			a.inviteError("invite.failed", safeInviteCode(err))
		}
		return
	}

	inviteLine, containsCredential, err := invitationContent(out, inviteFile)
	if err != nil {
		a.inviteError("invite.invalidResponse", "invite-response-invalid")
		return
	}

	// If contains broker credential, show warning and require confirmation (PRD R3 variant b)
	if containsCredential {
		if !askYesNo(tr("invite.title"), tr("invite.credentialWarning")) {
			return
		}
	}

	// Copy to clipboard
	if err := textToClipboard(inviteLine); err != nil {
		a.inviteError("invite.clipboardFailed", "clipboard-failed")
		return
	}

	// Show success with file as fallback
	a.mu.Lock()
	a.actionErr = nil
	a.mu.Unlock()
	tell(tr("invite.title"), tr("invite.done", inviteFile))
}

// Keep only known protocol codes, never arbitrary stderr or credentials.
func safeInviteCode(err error) string {
	step := "invite"
	value := err.Error()
	for _, prefix := range []string{"init: ", "token: ", "service-install: ", "service-start: "} {
		if strings.HasPrefix(value, prefix) {
			step = strings.TrimSuffix(prefix, ": ")
			value = strings.TrimPrefix(value, prefix)
			break
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		value = "timeout"
	}
	if errors.Is(err, errElevationCancelled) {
		value = "elevation-cancelled"
	}
	if !inviteDiagnosticCode.MatchString(value) {
		value = "operation-failed"
	}
	return step + ": " + value
}

var inviteDiagnosticCode = regexp.MustCompile(`^(?:(?:onboarding|service|system|config)\.[A-Za-z0-9_.:-]{1,140}|token-cleanup-failed|init-response-invalid|operation-failed|timeout|elevation-cancelled)$`)

func (a *app) inviteError(key, code string) {
	a.mu.Lock()
	a.actionErr = errors.New(code)
	a.mu.Unlock()
	showInviteError(tr(key), a.copyDiagnostics)
}
