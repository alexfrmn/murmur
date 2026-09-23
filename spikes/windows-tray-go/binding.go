package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type cliBinding struct{ Node, Entry, Profile, Service string }

// notConfigured: the tray was opened on its own and no profile exists yet. The menu offers
// to connect to a colleague instead of pointing at a launcher the user never saw.
func notConfigured() error { return &statusError{"profile.not-configured", tr("status.notConfigured")} }

// Discovery seams, replaced in tests.
var (
	trayExecutable = os.Executable
	lookNode       = func() (string, error) { return exec.LookPath("node") }
)

var serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$`)

// discoverCLI finds what the launcher would pass when the tray starts by itself (Start menu,
// Startup, a double click on the exe): the CLI of this bundle, Node next to the tray or on PATH
// (as the launcher does), and the profile last opened by the launcher or the default one.
func discoverCLI() (cliBinding, error) {
	b := cliBinding{}
	exe, err := trayExecutable()
	if err != nil {
		return b, errors.New(tr("binding.select"))
	}
	dir := filepath.Dir(exe)
	b.Entry = filepath.Join(dir, "runtime", "packages", "setup", "bin", "murmur.mjs")
	if info, err := os.Stat(b.Entry); err != nil || !info.Mode().IsRegular() {
		return b, errors.New(tr("binding.select"))
	}
	if info, err := os.Stat(filepath.Join(dir, "node.exe")); err == nil && info.Mode().IsRegular() {
		b.Node = filepath.Join(dir, "node.exe")
	} else if b.Node, err = lookNode(); err != nil {
		return b, errors.New(tr("binding.noNode"))
	}
	if b.Node, err = filepath.Abs(b.Node); err != nil {
		return b, errors.New(tr("binding.noNode"))
	}
	local := os.Getenv("LOCALAPPDATA")
	if !filepath.IsAbs(local) {
		return b, notConfigured()
	}
	// A profile chosen in the tray ("Open an existing profile…") comes first.
	if data, err := os.ReadFile(trayProfilePath(local)); err == nil && len(data) <= 4096 {
		var chosen struct {
			DataDir string `json:"dataDir"`
		}
		if json.Unmarshal(data, &chosen) == nil && filepath.IsAbs(chosen.DataDir) && isProfile(chosen.DataDir) {
			b.Profile = chosen.DataDir
			return b, nil
		}
	}
	// The launcher records the profile and service it opened; reuse that selection.
	var saved struct {
		DataDir     string  `json:"dataDir"`
		ServiceName *string `json:"serviceName"`
	}
	if data, err := os.ReadFile(filepath.Join(local, "Murmur", "tray-launch-binding.json")); err == nil && len(data) <= 65536 && json.Unmarshal(data, &saved) == nil &&
		filepath.IsAbs(saved.DataDir) && isProfile(saved.DataDir) && (saved.ServiceName == nil || serviceNamePattern.MatchString(*saved.ServiceName)) {
		b.Profile = saved.DataDir
		if saved.ServiceName != nil {
			b.Service = *saved.ServiceName
		}
		return b, nil
	}
	if def := filepath.Join(local, "Murmur"); isProfile(def) {
		b.Profile = def
		return b, nil
	}
	return b, notConfigured()
}

func isProfile(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, "agent-config.json"))
	return err == nil && info.Mode().IsRegular()
}

func selectedCLI() (cliBinding, error) {
	b := cliBinding{os.Getenv("MURMUR_BIN"), os.Getenv("MURMUR_CLI"), os.Getenv("MURMUR_PROFILE"), os.Getenv("MURMUR_SERVICE_NAME")}
	if b.Node == "" && b.Entry == "" && b.Profile == "" && b.Service == "" {
		var err error
		if b, err = discoverCLI(); err != nil {
			return b, err
		}
	}
	for _, p := range []string{b.Node, b.Entry, b.Profile} {
		if !filepath.IsAbs(p) || strings.ContainsAny(p, "\x00\r\n") {
			return b, errors.New(tr("binding.select"))
		}
	}
	for _, p := range []string{b.Node, b.Entry} {
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			return b, errors.New(tr("binding.moved"))
		}
	}
	if b.Service != "" && !serviceNamePattern.MatchString(b.Service) {
		return b, errors.New(tr("binding.invalidService"))
	}
	return b, nil
}
func (b cliBinding) arguments(args []string) []string {
	result := append([]string{b.Entry}, args...)
	result = append(result, "--data-dir", b.Profile)
	if b.Service != "" {
		result = append(result, "--service-name", b.Service)
	}
	return result
}
func (b cliBinding) environment() []string {
	allowed := map[string]bool{"systemroot": true, "windir": true, "programdata": true, "userprofile": true, "localappdata": true, "appdata": true, "temp": true, "tmp": true, "path": true, "home": true}
	result := []string{}
	for _, value := range os.Environ() {
		key, _, ok := strings.Cut(value, "=")
		if ok && allowed[strings.ToLower(key)] {
			result = append(result, value)
		}
	}
	result = append(result, "DATA_DIR="+b.Profile, "MURMUR_DATA_DIR="+b.Profile)
	if os.Getenv("MURMUR_UPDATE_CHECK") == "0" {
		result = append(result, "MURMUR_UPDATE_CHECK=0")
	}
	return result
}

type boundedOutput struct {
	bytes.Buffer
	exceeded bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := 256*1024 - b.Len()
	if n > left {
		b.exceeded = true
		p = p[:left]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}
func invokeCLI(ctx context.Context, args ...string) ([]byte, error) {
	b, err := selectedCLI()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, b.Node, b.arguments(args)...)
	cmd.Env = b.environment()
	cmd.Dir = filepath.Dir(b.Entry)
	hideConsole(cmd)
	var stdout, stderr boundedOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if stdout.exceeded || stderr.exceeded {
		return nil, errors.New(tr("binding.outputLarge"))
	}
	if err != nil {
		return nil, trError("binding.cliFailed", err, err)
	}
	return stdout.Bytes(), nil
}

// A fresh status may describe another identity after an external profile change.
// Never publish it as the previously selected agent or use it for mutation.
func validatePinnedStatus(s *Status, expected string) error {
	if s == nil || !schemaKnown(s.Schema, statusSchema) || s.AgentID == "" {
		return errors.New(tr("binding.identityUnconfirmed"))
	}
	age, ok := ageOf(s.GeneratedAt)
	if !ok || age > maxStatusAge || age < -clockSkewTolerance {
		return errors.New(tr("binding.statusAge"))
	}
	if expected != "" && s.AgentID != expected {
		return errors.New(tr("binding.identityChanged"))
	}
	return nil
}
func validateAction(buf []byte, command, action string) error {
	var v map[string]any
	if err := json.Unmarshal(buf, &v); err != nil {
		return err
	}
	if command == "service" && v["schema"] == "murmur.service/1" && v["action"] == action {
		return nil
	}
	if command == "wake" && v["schema"] == "murmur.wake/1" && v["configuredEnabled"] == (action == "resume") {
		return nil
	}
	return errors.New(tr("binding.actionUnconfirmed"))
}

var mutationTimeout = 60 * time.Second

// setupBinding is the bundle CLI and Node for first-profile setup, when no profile exists yet.
func setupBinding(profile string) (cliBinding, error) {
	b, err := discoverCLI()
	var se *statusError
	if err != nil && !(errors.As(err, &se) && se.code == "profile.not-configured") {
		return b, err
	}
	b.Profile, b.Service = profile, ""
	return b, nil
}

// runSetupCLI runs the CLI as the user and returns stdout, or the CLI's own error code (the one
// line safeError writes to stderr) so a failed step names its reason.
func runSetupCLI(ctx context.Context, b cliBinding, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, b.Node, append([]string{b.Entry}, args...)...)
	cmd.Env = b.environment()
	cmd.Dir = filepath.Dir(b.Entry)
	hideConsole(cmd)
	var stdout, stderr boundedOutput
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if code := strings.TrimSpace(stderr.String()); code != "" && !strings.ContainsAny(code, "\r\n") {
			return nil, errors.New(code)
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

func trayProfilePath(local string) string { return filepath.Join(local, "Murmur", "tray-profile.json") }

// chooseTrayProfile records an existing profile picked in the tray. Only a folder holding
// agent-config.json is accepted; the service name stays the one the CLI derives from the path.
func chooseTrayProfile(dir string) error {
	local := os.Getenv("LOCALAPPDATA")
	if !filepath.IsAbs(local) || !filepath.IsAbs(dir) || !isProfile(dir) {
		return errors.New(tr("profile.notAProfile"))
	}
	data, _ := json.Marshal(map[string]string{"schema": "murmur.tray-profile/1", "dataDir": dir})
	if err := os.MkdirAll(filepath.Dir(trayProfilePath(local)), 0o700); err != nil {
		return err
	}
	temporary := trayProfilePath(local) + ".tmp"
	if err := os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, trayProfilePath(local))
}
