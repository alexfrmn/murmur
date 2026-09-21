//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func usageFixture(t *testing.T, holders func(string) ([]uint32, error), serviceState func() string) profileUsageSnapshot {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "murmur.db"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	return probeProfileUsage(dir, profileUsageDeps{holders: holders, serviceState: serviceState})
}

func TestProfileUsageTreatsAnyStoreHolderAsInUse(t *testing.T) {
	called := false
	got := usageFixture(t, func(string) ([]uint32, error) { return []uint32{4242, 5252}, nil }, func() string {
		called = true
		return "absent"
	})
	if got.State != "in-use" || got.Reason != "profile.store-held" || called {
		t.Fatalf("holder evidence = %#v, service consulted=%v", got, called)
	}
}

func TestRestartManagerFindsAnUnmanagedStoreHolder(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "murmur.db")
	if err := os.WriteFile(store, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	handle, err := os.Open(store)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	got := probeProfileUsage(dir, profileUsageDeps{holders: holdersOf, serviceState: func() string {
		t.Fatal("SCM must not be consulted after direct holder evidence")
		return "unknown"
	}})
	if got.State != "in-use" || got.Reason != "profile.store-held" {
		t.Fatalf("live unmanaged file holder = %#v", got)
	}
}

func TestProfileUsageRequiresBothNoHoldersAndVerifiedStoppedService(t *testing.T) {
	noHolders := func(string) ([]uint32, error) { return nil, nil }
	for _, state := range []string{"stopped", "absent"} {
		got := usageFixture(t, noHolders, func() string { return state })
		if got.State != "free" || got.Reason != "profile.store-unheld" {
			t.Errorf("%s + no holders = %#v", state, got)
		}
	}
	for state, reason := range map[string]string{"running": "profile.managed-running-unobserved", "unknown": "profile.service-unverifiable"} {
		got := usageFixture(t, noHolders, func() string { return state })
		if got.State != "unknown" || got.Reason != reason {
			t.Errorf("%s + no holders = %#v", state, got)
		}
	}
}

func TestProfileUsageReturnsUnknownForMissingInvalidOrUnobservableStore(t *testing.T) {
	dir := t.TempDir()
	deps := profileUsageDeps{holders: func(string) ([]uint32, error) { return nil, errors.New("denied") }, serviceState: func() string { return "stopped" }}
	if got := probeProfileUsage(dir, deps); got.State != "unknown" || got.Reason != "profile.store-missing" {
		t.Fatalf("missing store = %#v", got)
	}
	if err := os.Mkdir(filepath.Join(dir, "murmur.db"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := probeProfileUsage(dir, deps); got.State != "unknown" || got.Reason != "profile.store-invalid" {
		t.Fatalf("directory store = %#v", got)
	}
	if err := os.Remove(filepath.Join(dir, "murmur.db")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "murmur.db"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := probeProfileUsage(dir, deps); got.State != "unknown" || got.Reason != "profile.probe-unavailable" {
		t.Fatalf("Restart Manager error = %#v", got)
	}
}

func TestInitialRestartManagerResultNeverCollapsesErrorsToNoHolders(t *testing.T) {
	if _, empty, err := initialHolderListSize(0, 0); err != nil || !empty {
		t.Fatalf("success with zero holders = empty %v, error %v", empty, err)
	}
	if size, empty, err := initialHolderListSize(errorMoreData, 2); err != nil || empty || size != 2 {
		t.Fatalf("two holders = size %d, empty %v, error %v", size, empty, err)
	}
	if _, _, err := initialHolderListSize(uintptr(windows.ERROR_ACCESS_DENIED), 0); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("access denied was not preserved: %v", err)
	}
	if _, _, err := initialHolderListSize(errorMoreData, 0); err == nil {
		t.Fatal("empty ERROR_MORE_DATA was accepted")
	}
}
