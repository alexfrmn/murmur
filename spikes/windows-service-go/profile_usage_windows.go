//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/svc"
)

type profileUsageSnapshot struct {
	Schema string `json:"schema"`
	State  string `json:"state"`
	Reason string `json:"reason"`
}

type profileUsageDeps struct {
	holders      func(string) ([]uint32, error)
	serviceState func() string
}

func probeProfileUsage(dataDir string, deps profileUsageDeps) profileUsageSnapshot {
	unknown := func(reason string) profileUsageSnapshot {
		return profileUsageSnapshot{Schema: "murmur.windows-profile-usage/1", State: "unknown", Reason: reason}
	}
	if dataDir == "" || !filepath.IsAbs(dataDir) {
		return unknown("profile.probe-unavailable")
	}
	store, err := canonicalLocation(filepath.Join(dataDir, "murmur.db"))
	if err != nil {
		if os.IsNotExist(err) {
			return unknown("profile.store-missing")
		}
		return unknown("profile.probe-unavailable")
	}
	info, err := os.Stat(store)
	if err != nil {
		if os.IsNotExist(err) {
			return unknown("profile.store-missing")
		}
		return unknown("profile.probe-unavailable")
	}
	if !info.Mode().IsRegular() {
		return unknown("profile.store-invalid")
	}
	holders, err := deps.holders(store)
	if err != nil {
		return unknown("profile.probe-unavailable")
	}
	if len(holders) > 0 {
		return profileUsageSnapshot{Schema: "murmur.windows-profile-usage/1", State: "in-use", Reason: "profile.store-held"}
	}
	switch deps.serviceState() {
	case "absent", "stopped":
		return profileUsageSnapshot{Schema: "murmur.windows-profile-usage/1", State: "free", Reason: "profile.store-unheld"}
	case "running":
		return unknown("profile.managed-running-unobserved")
	default:
		return unknown("profile.service-unverifiable")
	}
}

func selectedServiceUsageState() string {
	m, err := connectReadOnly()
	if err != nil {
		return "unknown"
	}
	defer m.Disconnect()
	s, err := openReadOnly(m, svcName())
	if err != nil {
		if serviceAbsent(err) {
			return "absent"
		}
		return "unknown"
	}
	defer s.Close()
	if ownService(s) != nil {
		return "unknown"
	}
	status, err := s.Query()
	if err != nil {
		return "unknown"
	}
	switch status.State {
	case svc.Stopped:
		return "stopped"
	case svc.Running:
		return "running"
	default:
		return "unknown"
	}
}

func printProfileUsage() error {
	selected, err := selectedDataDir("")
	result := profileUsageSnapshot{Schema: "murmur.windows-profile-usage/1", State: "unknown", Reason: "profile.probe-unavailable"}
	if err == nil {
		result = probeProfileUsage(selected, profileUsageDeps{holders: holdersOf, serviceState: selectedServiceUsageState})
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("profile usage response: %w", err)
	}
	fmt.Println(string(encoded))
	return nil
}
