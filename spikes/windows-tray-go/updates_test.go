package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func updateFixture(now time.Time) map[string]any {
	return map[string]any{"schema": "murmur.updates/1", "channel": "stable", "currentVersion": "2.9.0", "versionSource": "root-package-json", "comparison": "declared-release-version", "enabled": true, "state": "available", "reason": "updates.newer-release", "latestVersion": "2.10.0+build.1", "releaseUrl": "https://github.com/alexfrmn/murmur/releases/tag/v2.10.0%2Bbuild.1", "action": "open-release-page", "checkedAt": now.UTC().Format(time.RFC3339Nano), "lastSuccessAt": now.UTC().Format(time.RFC3339Nano), "nextCheckAt": now.Add(updateInterval).UTC().Format(time.RFC3339Nano), "cached": false, "stale": false, "checkIntervalMs": 21600000, "timeoutMs": 4000}
}
func updateJSON(t *testing.T, value map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestUpdateContractRequiresEveryFieldAndExactTypes(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	for key := range updateFixture(now) {
		t.Run("missing/"+key, func(t *testing.T) {
			v := updateFixture(now)
			delete(v, key)
			if _, err := decodeUpdates(updateJSON(t, v)); err == nil {
				t.Fatal("missing field accepted")
			}
		})
		t.Run("type/"+key, func(t *testing.T) {
			v := updateFixture(now)
			v[key] = []string{"invalid"}
			if _, err := decodeUpdates(updateJSON(t, v)); err == nil {
				t.Fatal("wrong type accepted")
			}
		})
	}
	for _, key := range []string{"enabled", "cached", "stale", "checkIntervalMs", "timeoutMs"} {
		v := updateFixture(now)
		v[key] = nil
		if _, err := decodeUpdates(updateJSON(t, v)); err == nil {
			t.Fatal("null scalar accepted", key)
		}
	}
	for _, tc := range []struct {
		key   string
		value any
	}{{"schema", "murmur.updates/01"}, {"channel", "preview"}, {"versionSource", "guessed"}, {"comparison", "source-revision"}, {"state", "green"}, {"reason", "raw\nserver"}, {"checkedAt", "tomorrow"}, {"checkIntervalMs", 60000}, {"timeoutMs", 999}, {"currentVersion", ""}, {"latestVersion", "bad\nversion"}, {"action", nil}, {"enabled", false}, {"stale", true}} {
		v := updateFixture(now)
		v[tc.key] = tc.value
		if _, err := decodeUpdates(updateJSON(t, v)); err == nil {
			t.Fatal("invalid contract accepted", tc)
		}
	}
}
func TestUpdateStatesFreshnessAndNoVersionComparison(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	v := updateFixture(now)
	// The shell consumes the engine verdict, rather than inventing another comparator.
	v["currentVersion"] = "999.0.0"
	v["extraFutureField"] = true
	s, err := decodeUpdates(updateJSON(t, v))
	if err != nil || s.page(now) == "" {
		t.Fatal(s, err)
	}
	for _, at := range []time.Time{now.Add(updateInterval + time.Millisecond), now.Add(-6 * time.Second)} {
		if s.page(at) != "" {
			t.Fatal("expired/future result remains actionable")
		}
	}
	v["state"] = "up-to-date"
	v["reason"] = "updates.no-newer-release"
	v["action"] = nil
	v["releaseUrl"] = nil
	s, err = decodeUpdates(updateJSON(t, v))
	if err != nil || s.page(now) != "" || s.title(now) != "No newer stable release found" {
		t.Fatal(s, err)
	}
	v["state"] = "unknown"
	v["reason"] = "updates.network-error"
	v["latestVersion"] = nil
	v["stale"] = true
	s, err = decodeUpdates(updateJSON(t, v))
	if err != nil || s.page(now) != "" || s.title(now) != "Updates: unable to check" {
		t.Fatal(s, err)
	}
	v["action"] = "open-release-page"
	if _, err = decodeUpdates(updateJSON(t, v)); err == nil {
		t.Fatal("unknown with action")
	}
	v["action"] = nil
	v["enabled"] = false
	v["reason"] = "updates.disabled"
	v["checkedAt"] = nil
	v["lastSuccessAt"] = nil
	v["nextCheckAt"] = nil
	v["stale"] = false
	s, err = decodeUpdates(updateJSON(t, v))
	if err != nil || s.title(now) != "Update checks are disabled" || s.observation(now) != "No network check recorded" {
		t.Fatal(s, err)
	}
}
func TestUpdateReleaseDestination(t *testing.T) {
	for _, raw := range []string{"http://github.com/alexfrmn/murmur/releases/tag/v3.0.0", "https://github.com.evil/alexfrmn/murmur/releases/tag/v3.0.0", "https://user@github.com/alexfrmn/murmur/releases/tag/v3.0.0", "https://github.com:443/alexfrmn/murmur/releases/tag/v3.0.0", "https://github.com/alexfrmn/murmur/releases/tag/../x", "https://github.com/alexfrmn/murmur/releases/tag/%2e%2e", "https://github.com/alexfrmn/murmur/releases/tag/v3%2fextra", "https://github.com/alexfrmn/murmur/releases/tag/v3?", "https://github.com/alexfrmn/murmur/releases/tag/v3#", "https://github.com/other/murmur/releases/tag/v3", "file:///tmp/download.exe", "https://github.com/alexfrmn/murmur/releases/tag/v3%0a", "https://github.com/alexfrmn/murmur/releases/tag/v3%5cfoo"} {
		if officialReleasePage(raw) {
			t.Fatal("unsafe destination accepted", raw)
		}
	}
	if !officialReleasePage("https://github.com/alexfrmn/murmur/releases/tag/v2.10.0%2Bbuild.1") {
		t.Fatal("encoded metadata rejected")
	}
}
func TestUpdatesInvokeBoundCLIAndValidatePreferenceReadback(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	node, _ = filepath.Abs(node)
	dir := t.TempDir()
	entry := filepath.Join(dir, "update fixture.mjs")
	response := filepath.Join(dir, "response.json")
	fixture := `import fs from 'node:fs';const args=process.argv.slice(2);if(args[0]!=='updates'||args.at(-4)!=='--data-dir'||process.env.NODE_OPTIONS||process.env.MURMUR_STORE_PATH||process.env.MURMUR_UPDATE_CHECK!=='0')process.exit(41);console.log(fs.readFileSync(new URL('response.json',import.meta.url),'utf8'));`
	if err = os.WriteFile(entry, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MURMUR_BIN", node)
	t.Setenv("MURMUR_CLI", entry)
	t.Setenv("MURMUR_PROFILE", filepath.Join(dir, "profile"))
	t.Setenv("MURMUR_SERVICE_NAME", "UpdatesTest")
	t.Setenv("NODE_OPTIONS", "--require /bad")
	t.Setenv("MURMUR_STORE_PATH", "wrong")
	t.Setenv("MURMUR_UPDATE_CHECK", "0")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	os.WriteFile(response, updateJSON(t, updateFixture(time.Now())), 0600)
	if s, err := fetchUpdates(ctx); err != nil || s.State != "available" {
		t.Fatal(s, err)
	}
	for _, tc := range []struct {
		body string
		want bool
		ok   bool
	}{{`{"schema":"murmur.update-preferences/1","enabled":false}`, false, true}, {`{"schema":"murmur.update-preferences/1","enabled":false}`, true, false}, {`{"schema":"murmur.update-preferences/1","enabled":null}`, false, false}, {`{"schema":"murmur.update-preferences/1"}`, false, false}, {`{"schema":"murmur.update-preferences/2","enabled":true}`, true, false}} {
		os.WriteFile(response, []byte(tc.body), 0600)
		if (setUpdatesEnabled(ctx, tc.want) == nil) != tc.ok {
			t.Fatal(tc)
		}
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	if _, err := fetchUpdates(cancelled); err == nil {
		t.Fatal("cancelled CLI accepted")
	}
}
func TestUpdateBadgePreservesHealthAndUnread(t *testing.T) {
	plain, err := png.Decode(bytes.NewReader(iconBytes(colRed, true)[22:]))
	if err != nil {
		t.Fatal(err)
	}
	updated, err := png.Decode(bytes.NewReader(iconBytes(colRed, true, true)[22:]))
	if err != nil {
		t.Fatal(err)
	}
	for _, point := range [][2]int{{16, 16}, {24, 24}} {
		if plain.At(point[0], point[1]) != updated.At(point[0], point[1]) {
			t.Fatal("health/unread changed")
		}
	}
	if plain.At(8, 8) == updated.At(8, 8) {
		t.Fatal("no separate update badge")
	}
}
