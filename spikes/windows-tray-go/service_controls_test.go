package main

import (
	"strings"
	"testing"
)

func TestUnmanagedServiceControls(t *testing.T) {
	defer setLocale(defaultLocale)
	for _, locale := range []string{"en", "ru"} {
		setLocale(locale)
		for _, fixture := range []string{"status-running-unmanaged.json", "status-unmanaged-dead-letter.json", "status-unmanaged-paused.json", "status-unmanaged-no-server.json"} {
			s := load(t, fixture)
			for _, admin := range []bool{false, true} {
				enabled, state, hint := serviceControls(s, true, admin)
				if enabled || state != tr("menu.serviceUnmanaged") || hint != tr("menu.serviceUnmanagedTooltip") {
					t.Fatalf("%s/%s/admin=%t: unmanaged lifecycle controls must be disabled with an explanation", locale, fixture, admin)
				}
			}
		}
	}
}

func TestManagedServiceControls(t *testing.T) {
	s := load(t, "status-running-unmanaged.json")
	s.Service.State = "running"
	for _, ready := range []bool{false, true} {
		enabled, state, _ := serviceControls(s, ready, false)
		if enabled != ready || state != "" {
			t.Fatal("managed Service keeps its own lifecycle controls")
		}
	}
	if enabled, _, _ := serviceControls(nil, true, true); enabled {
		t.Fatal("missing status cannot enable controls")
	}
}

func unknownService(t *testing.T, detail string) *Status {
	t.Helper()
	s := load(t, "status-green.json")
	s.Service.State, s.Service.Manager, s.Service.Detail = "unknown", "windows-service", detail
	return s
}

// A Service left by a pilot or an earlier version is its own state with one way out: the
// question, then a single elevated install that replaces it. Another program's Service is
// refused in one sentence and nothing is run.
func TestPreviousInstallationServiceIsReplacedOnlyAfterTheQuestion(t *testing.T) {
	defer setLocale(defaultLocale)
	for _, locale := range []string{"en", "ru"} {
		setLocale(locale)
		previous := unknownService(t, "service.previous-installation")
		if serviceOrigin(previous) != serviceOriginPrevious {
			t.Fatal("previous installation Service not recognised")
		}
		for _, admin := range []bool{false, true} {
			enabled, state, hint := serviceControls(previous, true, admin)
			if enabled || state != tr("menu.servicePrevious") || hint != tr("menu.servicePreviousTooltip") {
				t.Fatalf("%s/admin=%t: previous installation Service must be its own disabled state line", locale, admin)
			}
		}
		for _, action := range []string{"install", "replace"} {
			args, question, refusal := serviceRequest(previous, action)
			if strings.Join(args, " ") != "service install --replace-previous" || question != tr("menu.replacePreviousConfirm") || refusal != "" {
				t.Fatalf("%s/%s: got %q %q %q", locale, action, args, question, refusal)
			}
		}
		for _, action := range []string{"start", "stop", "uninstall"} {
			if args, question, refusal := serviceRequest(previous, action); args != nil || question != "" || refusal != tr("menu.servicePreviousTooltip") {
				t.Fatalf("%s/%s: previous Service must not be started, stopped or removed on its own: %q %q %q", locale, action, args, question, refusal)
			}
		}
		foreign := unknownService(t, "service.foreign-image")
		if serviceOrigin(foreign) != serviceOriginForeign {
			t.Fatal("foreign Service not recognised")
		}
		if enabled, state, _ := serviceControls(foreign, true, true); enabled || state != tr("menu.serviceForeign") {
			t.Fatalf("%s: foreign Service must be its own disabled state line", locale)
		}
		for _, action := range []string{"install", "replace", "start", "stop", "uninstall"} {
			args, question, refusal := serviceRequest(foreign, action)
			if args != nil || question != "" || refusal != tr("menu.serviceForeignTooltip") || strings.Contains(strings.TrimSuffix(refusal, "."), ". ") {
				t.Fatalf("%s/%s: foreign Service must be refused in one sentence without a command: %q %q %q", locale, action, args, question, refusal)
			}
		}
	}
}

func TestOrdinaryServiceRequestsAreUnchanged(t *testing.T) {
	s := load(t, "status-green.json")
	for action, want := range map[string]string{"install": "service install", "start": "service start", "stop": "service stop", "uninstall": "service uninstall"} {
		args, question, refusal := serviceRequest(s, action)
		if strings.Join(args, " ") != want || refusal != "" || (question != "") != (action == "uninstall") {
			t.Fatalf("%s: got %q %q %q", action, args, question, refusal)
		}
	}
	// Once the previous Service is gone, a late replacement request has nothing to ask.
	if args, question, refusal := serviceRequest(s, "replace"); args != nil || question != "" || refusal != "" {
		t.Fatalf("replace without a previous Service: %q %q %q", args, question, refusal)
	}
	// An unknown Service without a named origin is not offered for replacement.
	if serviceOrigin(unknownService(t, "service.profile-unverified")) != "" {
		t.Fatal("unverified Service treated as a previous installation")
	}
	unmanaged := load(t, "status-running-unmanaged.json")
	if args, _, refusal := serviceRequest(unmanaged, "start"); args != nil || refusal != tr("menu.serviceUnmanagedTooltip") {
		t.Fatalf("unmanaged Service must still be refused: %q %q", args, refusal)
	}
}
