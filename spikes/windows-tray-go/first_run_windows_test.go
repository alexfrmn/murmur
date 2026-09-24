//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFirstRunNodeSelectionHonorsExplicitPath(t *testing.T) {
	root := t.TempDir()
	oldExecutable, oldNode := trayExecutable, lookNode
	t.Cleanup(func() { trayExecutable, lookNode = oldExecutable, oldNode })
	trayExecutable = func() (string, error) { return filepath.Join(root, "murmur-tray.exe"), nil }
	lookNode = func() (string, error) { return "", errors.New("not on PATH") }
	t.Setenv("MURMUR_BIN", "")
	if setupNodeAvailable() {
		t.Fatal("absent Node was accepted")
	}
	selected := filepath.Join(root, "explicit-node.exe")
	if err := os.WriteFile(selected, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MURMUR_BIN", selected)
	if !setupNodeAvailable() {
		t.Fatal("explicit Node was ignored when PATH was empty")
	}
	t.Setenv("MURMUR_BIN", "relative.exe")
	if setupNodeAvailable() {
		t.Fatal("relative explicit Node was accepted")
	}
	t.Setenv("MURMUR_BIN", root)
	if setupNodeAvailable() {
		t.Fatal("a directory was accepted as Node")
	}
	t.Setenv("MURMUR_BIN", "")
	if err := os.WriteFile(filepath.Join(root, "node.exe"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if !setupNodeAvailable() {
		t.Fatal("bundled Node was ignored")
	}
}

func TestFirstRunSelectionWithoutRuntime(t *testing.T) {
	local := t.TempDir()
	for _, key := range []string{"MURMUR_PROFILE", "MURMUR_STATUS_FILE", "MURMUR_CLI", "MURMUR_BIN", "MURMUR_SERVICE_NAME"} {
		t.Setenv(key, "")
	}
	t.Setenv("LOCALAPPDATA", local)
	if !needsFirstRun() {
		t.Fatal("fresh launch must show setup even without a runtime")
	}
	profile := filepath.Join(local, "Murmur")
	if err := os.MkdirAll(profile, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "agent-config.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if needsFirstRun() {
		t.Fatal("existing default identity must not show setup")
	}
	t.Setenv("MURMUR_PROFILE", filepath.Join(local, "missing"))
	if !needsFirstRun() {
		t.Fatal("missing explicitly selected identity must show setup")
	}
	t.Setenv("MURMUR_PROFILE", profile)
	if needsFirstRun() {
		t.Fatal("explicit identity must win")
	}
	t.Setenv("MURMUR_PROFILE", "")
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("MURMUR_STATUS_FILE", "fixture.json")
	if needsFirstRun() {
		t.Fatal("debug snapshots cannot start onboarding")
	}
}

func TestFirstRunDispatchAndCancel(t *testing.T) {
	for _, choice := range []int{firstRunJoin, firstRunInvite, firstRunExisting, 0, 2} {
		called := 0
		actions := firstRunActions{func() { called = firstRunJoin }, func() { called = firstRunInvite }, func() { called = firstRunExisting }}
		dispatchFirstRun(choice, actions)
		want := choice
		if choice == 2 {
			want = 0
		}
		if called != want {
			t.Fatalf("choice %d called %d", choice, called)
		}
	}
}

func TestSystemLocaleOnlyBeforeExplicitChoice(t *testing.T) {
	old := systemLocale
	t.Cleanup(func() { systemLocale = old })
	systemLocale = func() string { return localeRussian }
	path := filepath.Join(t.TempDir(), "preferences.json")
	if loadLocalePreference(path) != localeRussian {
		t.Fatal("system language ignored")
	}
	if err := saveLocalePreference(path, localeEnglish); err != nil {
		t.Fatal(err)
	}
	if loadLocalePreference(path) != localeEnglish {
		t.Fatal("explicit choice lost")
	}
}

func TestClickingCurrentLanguageStillPersistsExplicitChoice(t *testing.T) {
	previous := currentLocale()
	oldSystem := systemLocale
	t.Cleanup(func() { systemLocale = oldSystem; setLocale(previous) })
	setLocale(localeEnglish)
	preferences := filepath.Join(t.TempDir(), "preferences.json")
	a := &app{preferencesPath: preferences}
	a.changeLocale(localeEnglish)
	if _, err := os.Stat(preferences); err != nil {
		t.Fatal("explicit choice was not saved", err)
	}
	systemLocale = func() string { return localeRussian }
	if loadLocalePreference(preferences) != localeEnglish {
		t.Fatal("a changed Windows language overrode the explicit choice")
	}
}
