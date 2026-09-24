package main

import "testing"

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
