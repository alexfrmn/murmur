package main

// Consume the shared CLI contract. Version comparison, networking and cache
// selection belong to the engine, never to the tray.
import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
)

const updateInterval = 6 * time.Hour

var errUpdateResponse = errors.New("update response was not confirmed")
var releaseTag = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)
var updateReason = regexp.MustCompile(`^updates\.[a-z0-9.-]{1,100}$`)

type updateSnapshot struct {
	Schema          string  `json:"schema"`
	Channel         string  `json:"channel"`
	CurrentVersion  *string `json:"currentVersion"`
	VersionSource   string  `json:"versionSource"`
	Comparison      string  `json:"comparison"`
	Enabled         bool    `json:"enabled"`
	State           string  `json:"state"`
	Reason          string  `json:"reason"`
	LatestVersion   *string `json:"latestVersion"`
	ReleaseURL      *string `json:"releaseUrl"`
	Action          *string `json:"action"`
	CheckedAt       *string `json:"checkedAt"`
	LastSuccessAt   *string `json:"lastSuccessAt"`
	NextCheckAt     *string `json:"nextCheckAt"`
	Cached          bool    `json:"cached"`
	Stale           bool    `json:"stale"`
	CheckIntervalMs int     `json:"checkIntervalMs"`
	TimeoutMs       int     `json:"timeoutMs"`
}

func officialReleasePage(raw string) bool {
	u, err := url.Parse(raw)
	const prefix = "/alexfrmn/murmur/releases/tag/"
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || !strings.HasPrefix(u.EscapedPath(), prefix) {
		return false
	}
	tag, err := url.PathUnescape(strings.TrimPrefix(u.EscapedPath(), prefix))
	return err == nil && !strings.Contains(tag, "..") && releaseTag.MatchString(tag)
}

func decodeUpdates(data []byte) (*updateSnapshot, error) {
	var fields map[string]json.RawMessage
	var value updateSnapshot
	if json.Unmarshal(data, &fields) != nil || json.Unmarshal(data, &value) != nil {
		return nil, errUpdateResponse
	}
	nullable := map[string]bool{"currentVersion": true, "latestVersion": true, "releaseUrl": true, "action": true, "checkedAt": true, "lastSuccessAt": true, "nextCheckAt": true}
	for _, key := range []string{"schema", "channel", "currentVersion", "versionSource", "comparison", "enabled", "state", "reason", "latestVersion", "releaseUrl", "action", "checkedAt", "lastSuccessAt", "nextCheckAt", "cached", "stale", "checkIntervalMs", "timeoutMs"} {
		raw, ok := fields[key]
		if !ok || (!nullable[key] && string(raw) == "null") {
			return nil, errUpdateResponse
		}
	}
	if !schemaKnown(value.Schema, "murmur.updates/1") || value.Channel != "stable" || value.VersionSource != "root-package-json" || value.Comparison != "declared-release-version" || value.CheckIntervalMs != int(updateInterval/time.Millisecond) || value.TimeoutMs != 4000 || !updateReason.MatchString(value.Reason) {
		return nil, errUpdateResponse
	}
	for _, version := range []*string{value.CurrentVersion, value.LatestVersion} {
		if version != nil && (len(*version) == 0 || len(*version) > 128 || strings.IndexFunc(*version, unicode.IsControl) >= 0) {
			return nil, errUpdateResponse
		}
	}
	for _, stamp := range []*string{value.CheckedAt, value.LastSuccessAt, value.NextCheckAt} {
		if stamp != nil {
			if _, err := time.Parse(time.RFC3339Nano, *stamp); err != nil {
				return nil, errUpdateResponse
			}
		}
	}
	switch value.State {
	case "unknown":
		if value.Action != nil || value.ReleaseURL != nil || value.Reason == "updates.newer-release" || value.Reason == "updates.no-newer-release" {
			return nil, errUpdateResponse
		}
	case "available", "up-to-date":
		if !value.Enabled || value.Stale || value.CurrentVersion == nil || value.LatestVersion == nil || value.CheckedAt == nil || value.LastSuccessAt == nil {
			return nil, errUpdateResponse
		}
		if value.State == "available" {
			if value.Reason != "updates.newer-release" || value.Action == nil || *value.Action != "open-release-page" || value.ReleaseURL == nil || !officialReleasePage(*value.ReleaseURL) {
				return nil, errUpdateResponse
			}
		} else if value.Reason != "updates.no-newer-release" || value.Action != nil || value.ReleaseURL != nil {
			return nil, errUpdateResponse
		}
	default:
		return nil, errUpdateResponse
	}
	return &value, nil
}

func (s *updateSnapshot) expired(now time.Time) bool {
	if s == nil || s.CheckedAt == nil {
		return true
	}
	at, err := time.Parse(time.RFC3339Nano, *s.CheckedAt)
	return err != nil || now.Sub(at) > updateInterval || at.Sub(now) > 5*time.Second
}
func (s *updateSnapshot) page(now time.Time) string {
	if s == nil || s.State != "available" || !s.Enabled || s.Stale || s.expired(now) || s.Action == nil || *s.Action != "open-release-page" || s.ReleaseURL == nil || !officialReleasePage(*s.ReleaseURL) {
		return ""
	}
	return *s.ReleaseURL
}
func (s *updateSnapshot) title(now time.Time) string {
	if s == nil {
		return tr("updates.notChecked")
	}
	if !s.Enabled && s.Reason == "updates.disabled" {
		return tr("updates.disabled")
	}
	if s.State != "unknown" && s.expired(now) {
		return tr("updates.expired")
	}
	switch s.State {
	case "available":
		return tr("updates.available", *s.LatestVersion)
	case "up-to-date":
		return tr("updates.none")
	default:
		return tr("updates.failed")
	}
}
func (s *updateSnapshot) observation(now time.Time) string {
	if s == nil || s.CheckedAt == nil {
		return tr("updates.noCheck")
	}
	at, _ := time.Parse(time.RFC3339Nano, *s.CheckedAt)
	age := int(now.Sub(at) / time.Minute)
	if age < 0 {
		age = 0
	}
	label := tr("updates.checked")
	if s.Cached {
		label = tr("updates.cached")
	}
	return tr("updates.observation", label, at.UTC().Format("2006-01-02 15:04:05 UTC"), age)
}

func updateReasonLabel(reason string) string {
	if reason == "" {
		return ""
	}
	key := "updates.reason." + strings.TrimPrefix(reason, "updates.")
	if value, ok := catalogs[currentLocale()][key]; ok {
		return value
	}
	return reason
}

// Manual checks preserve consent and use the same CLI cache as scheduled checks.
// Each subprocess keeps its own existing timeout, including preference changes.
func performUpdateRequest(parent context.Context, preference *bool, limit time.Duration) (*updateSnapshot, error) {
	if preference != nil {
		ctx, cancel := context.WithTimeout(parent, limit)
		err := setUpdatesEnabled(ctx, *preference)
		cancel()
		if err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(parent, limit)
	defer cancel()
	return fetchUpdates(ctx)
}

func fetchUpdates(ctx context.Context) (*updateSnapshot, error) {
	data, err := runRaw(ctx, "updates", "check", "--json")
	if err != nil {
		return nil, err
	}
	return decodeUpdates(data)
}
func setUpdatesEnabled(ctx context.Context, enabled bool) error {
	action := "disable"
	if enabled {
		action = "enable"
	}
	data, err := runRaw(ctx, "updates", action, "--json")
	if err != nil {
		return err
	}
	var value struct {
		Schema  string `json:"schema"`
		Enabled *bool  `json:"enabled"`
	}
	if json.Unmarshal(data, &value) != nil || !schemaKnown(value.Schema, "murmur.update-preferences/1") || value.Enabled == nil || *value.Enabled != enabled {
		return errUpdateResponse
	}
	return nil
}
