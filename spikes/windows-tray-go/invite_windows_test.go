//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestInviteDiagnosticsRetainStepAndSafeCode(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"init: onboarding.token-file-invalid", "init: onboarding.token-file-invalid"},
		{"service-install: service.owner-conflict", "service-install: service.owner-conflict"},
		{"init: password=synthetic-secret", "init: operation-failed"},
		{"token-cleanup-failed", "invite: token-cleanup-failed"},
	} {
		if got := safeInviteCode(errors.New(tc.in)); got != tc.want {
			t.Fatalf("got %q want %q", got, tc.want)
		}
	}
}

func TestPrivateInviteTokenACLAndCleanup(t *testing.T) {
	path, remove, err := privateInviteToken("synthetic-only")
	if err != nil {
		t.Fatal(err)
	}
	defer remove()
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "synthetic-only" {
		t.Fatal("token contents")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{filepath.Dir(path), path} {
		sd, err := windows.GetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		sddl := sd.String()
		if strings.Count(sddl, "(A;") != 1 || !strings.Contains(sddl, user.User.Sid.String()) {
			t.Fatalf("unexpected ACL %s", sddl)
		}
	}
	if err := remove(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("credential directory remains")
	}
}

// Opt-in visual fixture: never invokes setup, installs a service or creates an Identity.
func TestInviteWindowCapture(t *testing.T) {
	mode := os.Getenv("MURMUR_CAPTURE_INVITE")
	if mode == "" {
		t.Skip("native visual fixture")
	}
	setLocale(os.Getenv("MURMUR_CAPTURE_LOCALE"))
	switch mode {
	case "form":
		showInviteIdentity()
	case "error":
		showInviteError(tr("invite.publicServerRequired"), func() {})
	case "before":
		if currentLocale() == localeRussian {
			tell(tr("invite.title"), "Сначала создайте свою личность Murmur. Используйте «Подключиться к коллеге…» с приглашением или откройте существующую папку личности.")
		} else {
			tell(tr("invite.title"), "Create your Murmur identity first. Use Connect to a colleague with an invitation, or open an existing identity folder.")
		}
	default:
		t.Fatal("unknown capture mode")
	}
}
