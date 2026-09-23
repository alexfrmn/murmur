package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// discoveryFixture lays out a bundle (tray exe + runtime CLI) and a LOCALAPPDATA, with no
// launcher environment: the tray was opened from the Start menu, Startup or by a double click.
func discoveryFixture(t *testing.T) (bundle, local, node string) {
	t.Helper()
	root := t.TempDir()
	bundle = filepath.Join(root, "Мурмур bundle")
	entry := filepath.Join(bundle, "runtime", "packages", "setup", "bin", "murmur.mjs")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("// cli"), 0o644); err != nil {
		t.Fatal(err)
	}
	node = filepath.Join(root, "nodejs", "node.exe")
	if err := os.MkdirAll(filepath.Dir(node), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(node, []byte("node"), 0o755); err != nil {
		t.Fatal(err)
	}
	local = filepath.Join(root, "Local")
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"MURMUR_BIN", "MURMUR_CLI", "MURMUR_PROFILE", "MURMUR_SERVICE_NAME"} {
		t.Setenv(name, "")
	}
	t.Setenv("LOCALAPPDATA", local)
	oldExe, oldNode := trayExecutable, lookNode
	trayExecutable = func() (string, error) { return filepath.Join(bundle, "murmur-tray.exe"), nil }
	lookNode = func() (string, error) { return node, nil }
	t.Cleanup(func() { trayExecutable, lookNode = oldExe, oldNode })
	return bundle, local, node
}

func writeProfile(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-config.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestTrayOpenedAloneWithoutProfileIsNotConfigured(t *testing.T) {
	discoveryFixture(t)
	_, err := selectedCLI()
	var se *statusError
	if !errors.As(err, &se) || se.code != "profile.not-configured" {
		t.Fatalf("want profile.not-configured, got %v", err)
	}
	v := resolve(nil, err)
	if v.Code != "profile.not-configured" || v.Reason != tr("status.notConfigured") || v.Level != LevelGrey {
		t.Fatalf("verdict %+v", v)
	}
}

func TestTrayOpenedAloneUsesTheProfileTheLauncherLastOpened(t *testing.T) {
	bundle, local, node := discoveryFixture(t)
	profile := filepath.Join(local, "Murmur-claude-win")
	writeProfile(t, profile)
	writeProfile(t, filepath.Join(local, "Murmur")) // a default profile must not win over the saved choice
	saved := `{"schema":"murmur.windows-tray-binding/1","dataDir":` + quoteJSON(profile) + `,"serviceName":"ChosenService"}`
	if err := os.MkdirAll(filepath.Join(local, "Murmur"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(local, "Murmur", "tray-launch-binding.json"), []byte(saved), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := selectedCLI()
	if err != nil {
		t.Fatal(err)
	}
	want := cliBinding{node, filepath.Join(bundle, "runtime", "packages", "setup", "bin", "murmur.mjs"), profile, "ChosenService"}
	if b != want {
		t.Fatalf("got %+v want %+v", b, want)
	}
}

func TestTrayOpenedAloneFallsBackToTheDefaultProfileAndBundledNode(t *testing.T) {
	bundle, local, _ := discoveryFixture(t)
	writeProfile(t, filepath.Join(local, "Murmur"))
	bundled := filepath.Join(bundle, "node.exe")
	if err := os.WriteFile(bundled, []byte("node"), 0o755); err != nil {
		t.Fatal(err)
	}
	lookNode = func() (string, error) {
		t.Fatal("PATH must not be searched when the bundle carries Node")
		return "", nil
	}
	b, err := selectedCLI()
	if err != nil {
		t.Fatal(err)
	}
	if b.Node != bundled || b.Profile != filepath.Join(local, "Murmur") || b.Service != "" {
		t.Fatalf("got %+v", b)
	}
}

func TestTrayWithoutNodeSaysSoAndLauncherBindingStaysStrict(t *testing.T) {
	discoveryFixture(t)
	lookNode = func() (string, error) { return "", errors.New("not found") }
	if _, err := selectedCLI(); err == nil || err.Error() != tr("binding.noNode") {
		t.Fatalf("want binding.noNode, got %v", err)
	}
	// A partial launcher binding is still an error, never silently completed by discovery.
	t.Setenv("MURMUR_PROFILE", `C:\profile`)
	if _, err := selectedCLI(); err == nil || err.Error() != tr("binding.select") {
		t.Fatalf("want binding.select, got %v", err)
	}
}

func quoteJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
