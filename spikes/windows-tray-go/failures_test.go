package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// engineClientCodes reads every client.* code the setup engine can throw from its sources, so
// the tray table cannot silently fall behind the engine again.
func engineClientCodes(t *testing.T) []string {
	t.Helper()
	found := map[string]bool{}
	literal := regexp.MustCompile("['\"`](client\\.[a-z][a-z-]*)['\"`]")
	err := filepath.WalkDir(filepath.Join("..", "..", "packages", "setup", "src"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".ts") {
			return err
		}
		data, err := os.ReadFile(path)
		for _, m := range literal.FindAllStringSubmatch(string(data), -1) {
			found[m[1]] = true
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	codes := make([]string, 0, len(found))
	for code := range found {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	// 13 on 2026-09-25; fewer means the reader broke, not that the engine shrank.
	if len(codes) < 13 {
		t.Fatalf("read only %d client codes from the engine: %v", len(codes), codes)
	}
	return codes
}

func TestEveryEngineClientCodeHasAnActionSentence(t *testing.T) {
	defer setLocale(currentLocale())
	codes := engineClientCodes(t)
	for _, locale := range []string{localeEnglish, localeRussian} {
		setLocale(locale)
		generic := tr("assistants.failed")
		for _, code := range codes {
			key, ok := assistantFailureKeys[code]
			if !ok {
				t.Errorf("engine code %s has no sentence in assistantFailureKeys", code)
				continue
			}
			if catalogs[localeEnglish][key] == "" || catalogs[localeRussian][key] == "" {
				t.Errorf("%s → %s is missing from a locale", code, key)
			}
			message := assistantFailure(errors.New(code))
			if message != tr(key) || message == generic || strings.Contains(message, code) {
				t.Errorf("[%s] %s shows %q", locale, code, message)
			}
		}
	}
	t.Logf("%d engine client codes: %v", len(codes), codes)
}

func TestUnknownAssistantCodeIsNamedAndCrashIsASentence(t *testing.T) {
	defer setLocale(currentLocale())
	crash := newCLIFailure([]byte("file:///murmur.mjs:3\nthrow new Error('boom')\n^\n\nError: boom\n    at file:///murmur.mjs:3:7\n\nNode.js v22.22.3\n"), errors.New("exit status 1"), nil)
	for _, tc := range []struct{ locale, code, crash string }{
		{localeEnglish, "(code: client.brand-new-code)", "The Murmur command failed; details are in the diagnostics"},
		{localeRussian, "(код: client.brand-new-code)", "Команда Murmur завершилась с ошибкой; подробности — в диагностике"},
	} {
		setLocale(tc.locale)
		if got := assistantFailure(errors.New("client.brand-new-code")); !strings.HasPrefix(got, tr("assistants.failed")) || !strings.HasSuffix(got, tc.code) {
			t.Fatalf("[%s] unknown code hidden: %q", tc.locale, got)
		}
		if got := assistantFailure(errors.New("synthetic secret=value")); got != tr("assistants.failed") {
			t.Fatalf("[%s] raw text shown: %q", tc.locale, got)
		}
		got := assistantFailure(crash)
		if !strings.HasPrefix(got, tc.crash) || !strings.Contains(got, menuPath("menu.doctor", "menu.copy")) {
			t.Fatalf("[%s] crash is not a sentence: %q", tc.locale, got)
		}
	}
}

const hostileStderr = `(node:4242) Warning: an unrelated warning
(Use ` + "`node --trace-warnings ...`" + ` to show where the warning was created)
invitation MURMUR:eyJzZWNyZXQiOiJpbnZpdGUifQ
natsToken=tok_live_123
connecting nats://alice:hunter2@server.example.com:4222
Authorization: Bearer abc.def
client.config-file-invalid
`

func assertMasked(t *testing.T, lines []string) {
	t.Helper()
	joined := strings.Join(lines, "\n")
	for _, secret := range []string{"eyJzZWNyZXQi", "tok_live_123", "hunter2", "alice:", "abc.def"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("stderr secret %q reached diagnostics:\n%s", secret, joined)
		}
	}
}

func TestCLIFailureKeepsTheCodeAfterWarningsAndMasksStderr(t *testing.T) {
	f := newCLIFailure([]byte(hostileStderr), errors.New("exit status 1"), nil)
	if f.Code != "client.config-file-invalid" || f.Error() != "client.config-file-invalid" {
		t.Fatalf("code lost behind a warning: %q / %q", f.Code, f.Error())
	}
	if len(f.Stderr) != 7 || f.Stderr[0] != "(node:4242) Warning: an unrelated warning" || f.Stderr[6] != "client.config-file-invalid" {
		t.Fatalf("stderr lines: %q", f.Stderr)
	}
	redacted := 0
	for _, line := range f.Stderr {
		if line == redactedLine {
			redacted++
		}
	}
	if redacted != 4 {
		t.Fatalf("want 4 masked lines, got %d: %q", redacted, f.Stderr)
	}
	assertMasked(t, f.Stderr)

	// A code with "token" in it is a code, and a code with a sentence keeps the code.
	if f := newCLIFailure([]byte("onboarding.token-file-invalid\n"), errors.New("exit status 1"), nil); f.Code != "onboarding.token-file-invalid" || f.Stderr[0] != "onboarding.token-file-invalid" {
		t.Fatalf("code with token masked: %#v", f)
	}
	if f := newCLIFailure([]byte("runtime.node-version-unsupported: Use Node.js 22.5 or newer; current version is 20.1.\n"), errors.New("exit status 1"), nil); f.Code != "runtime.node-version-unsupported" || cliCrashed(f) {
		t.Fatalf("code with sentence lost: %#v", f)
	}

	frames := newCLIFailure([]byte("    at file:///C:/Murmur/runtime/cli.mjs:1:1\nserver tls://server.example.com:4222\n"), errors.New("exit status 1"), nil)
	if len(frames.Stderr) != 2 || frames.Stderr[0] != "at file:///C:/Murmur/runtime/cli.mjs:1:1" || frames.Stderr[1] != redactedLine {
		t.Fatalf("stack frame masked or Server address kept: %q", frames.Stderr)
	}

	var trace strings.Builder
	for i := 0; i < 30; i++ {
		trace.WriteString("    at frame (file:///murmur.mjs:1:1)\n")
	}
	long := newCLIFailure([]byte(trace.String()), errors.New("exit status 1"), context.DeadlineExceeded)
	if long.Code != "" || !cliCrashed(long) || len(long.Stderr) != stderrLineLimit || long.Omitted != 10 || long.Error() != "exit status 1" || !errors.Is(long, context.DeadlineExceeded) {
		t.Fatalf("long stderr: code=%q lines=%d omitted=%d err=%q", long.Code, len(long.Stderr), long.Omitted, long.Error())
	}
}

func fakeCLI(t *testing.T, script string) cliBinding {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	node, _ = filepath.Abs(node)
	dir := t.TempDir()
	entry := filepath.Join(dir, "fake cli.mjs")
	if err := os.WriteFile(entry, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	return cliBinding{Node: node, Entry: entry, Profile: filepath.Join(dir, "profile")}
}

// The real process path: before this change a multi-line stderr lost the code and all its lines.
func TestSetupCLIKeepsMultilineStderrAndMasksIt(t *testing.T) {
	defer setLocale(currentLocale())
	setLocale(localeRussian)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	b := fakeCLI(t, "process.stderr.write("+jsString(hostileStderr)+"); process.exitCode = 1;")
	_, err := runSetupCLI(ctx, b, "clients", "preview", "--client", "claude-code", "--json")
	var f *cliFailure
	if !errors.As(err, &f) || f.ExitCode != 1 || f.Code != "client.config-file-invalid" || err.Error() != "client.config-file-invalid" || len(f.Stderr) != 7 {
		t.Fatalf("multi-line stderr lost: %#v %v", f, err)
	}
	assertMasked(t, f.Stderr)
	if got := assistantFailure(err); got != tr("assistants.configFileInvalid") {
		t.Fatalf("window text %q", got)
	}

	crash := fakeCLI(t, "console.error('token=abc123'); throw new Error('boom');")
	_, err = runSetupCLI(ctx, crash, "clients", "detect", "--json")
	if !errors.As(err, &f) || f.Code != "" || f.ExitCode == 0 || !cliCrashed(err) || len(f.Stderr) < 3 {
		t.Fatalf("crash not recognised: %#v %v", f, err)
	}
	assertMasked(t, f.Stderr)
	if strings.Contains(strings.Join(f.Stderr, "\n"), "abc123") || !strings.Contains(strings.Join(f.Stderr, "\n"), "Error: boom") {
		t.Fatalf("crash stderr: %q", f.Stderr)
	}
	if got := assistantFailure(err); got != cliCrashText() {
		t.Fatalf("crash window text %q", got)
	}
	record := newActionFailure("assistants.connect", "claude-code", err, time.Now())
	if record.ExitCode == nil || *record.ExitCode == 0 || len(record.Stderr) == 0 || record.Code != "" {
		t.Fatalf("crash record: %#v", record)
	}
}

func jsString(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

type copiedDiagnostics struct {
	ActionError       string          `json:"actionError"`
	DoctorCollectedAt string          `json:"doctorCollectedAt"`
	Doctor            *Doctor         `json:"doctor"`
	LastFailedAction  *actionFailure  `json:"lastFailedAction"`
	Status            json.RawMessage `json:"status"`
}

func decodeDiagnostics(t *testing.T, s diagnosticsSnapshot) copiedDiagnostics {
	t.Helper()
	buf, err := diagnosticsJSON(s, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var copied copiedDiagnostics
	if err := json.Unmarshal(buf, &copied); err != nil {
		t.Fatal(err)
	}
	return copied
}

// "Connect Assistants" from the menu: the failure reaches "Copy diagnostics" with the action,
// its time, the code and the masked stderr.
func TestAssistantMenuFailureReachesDiagnostics(t *testing.T) {
	defer setLocale(currentLocale())
	setLocale(localeRussian)
	failure := newCLIFailure([]byte(hostileStderr), errors.New("exit status 1"), nil)
	at := time.Date(2026, 9, 24, 12, 30, 0, 0, time.UTC)
	var recorded *actionFailure
	var recordedErr error
	var shown []string
	s := onboardingSteps{
		chooseClients: func(found []string) []string { return found },
		inform:        func(_, text string) { shown = append(shown, text) },
		failed: func(action, target string, err error) {
			recordedErr, recorded = err, newActionFailure(action, target, err, at)
		},
		cli: func(args ...string) ([]byte, error) {
			if args[1] == "detect" {
				return []byte(`{"schema":"murmur.clients/1","clients":[{"id":"claude-code","installed":true}]}`), nil
			}
			return nil, failure
		},
	}
	if connected := connectAssistants(s, t.TempDir(), "me"); len(connected) != 0 {
		t.Fatal(connected)
	}
	if len(shown) != 1 || shown[0] != tr("assistants.clientFailed", "Claude Code", tr("assistants.configFileInvalid")) {
		t.Fatalf("window text %q", shown)
	}
	copied := decodeDiagnostics(t, diagnosticsSnapshot{actionErr: recordedErr, lastFailed: recorded})
	f := copied.LastFailedAction
	if f == nil || f.Action != "assistants.connect" || f.Target != "claude-code" || f.At != "2026-09-24T12:30:00Z" || f.Code != "client.config-file-invalid" || f.ExitCode == nil || len(f.Stderr) != 7 {
		t.Fatalf("diagnostics lost the failure: %#v", f)
	}
	if copied.ActionError != "client.config-file-invalid" {
		t.Fatalf("actionError %q", copied.ActionError)
	}
	assertMasked(t, f.Stderr)

	// A detection failure is kept too, and a cancelled replacement is not a failure.
	recorded = nil
	s.cli = func(...string) ([]byte, error) { return nil, failure }
	connectAssistants(s, t.TempDir(), "me")
	if recorded == nil || recorded.Action != "assistants.detect" || recorded.Code != "client.config-file-invalid" {
		t.Fatalf("detect failure not recorded: %#v", recorded)
	}
}

// engineFixHint is the engine's own hint for a stopped Service, read from doctor.ts.
func engineFixHint(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "packages", "setup", "src", "doctor.ts"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile("'daemon\\.not-running': `([^`]+)`").FindSubmatch(data)
	if m == nil || !strings.Contains(string(m[1]), "murmur service install") {
		t.Fatal("engine hint for daemon.not-running not found in doctor.ts")
	}
	return strings.ReplaceAll(string(m[1]), "${serviceName}", "Murmur")
}

func stageFailureReply(identity, peer, stage, reason, fixHint string) []byte {
	stages := []any{}
	failed := false
	for _, id := range []string{"config", "daemon", "broker", "peers", "roundtrip", "wake"} {
		entry := map[string]any{"id": id, "state": "ok", "reason": nil, "fixHint": nil}
		switch {
		case failed:
			entry["state"], entry["reason"] = "skip", "blocked-by:"+stage
		case id == stage:
			entry["state"], entry["reason"], failed = "fail", reason, true
			if fixHint != "" {
				entry["fixHint"] = fixHint
			}
		}
		stages = append(stages, entry)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	out, _ := json.Marshal(map[string]any{"schema": doctorSchema, "agentId": identity, "generatedAt": now, "stages": stages,
		"peerCheck": map[string]any{"peerId": peer, "state": "failed", "reason": reason, "lastExchangeAt": nil, "requestMsgId": nil, "replyMsgId": nil}})
	return out
}

func TestContactCheckNamesStageAndCodeWithTrayActions(t *testing.T) {
	defer setLocale(currentLocale())
	hint := engineFixHint(t)
	for _, locale := range []string{localeEnglish, localeRussian} {
		setLocale(locale)
		_, err := parseContactCheck(stageFailureReply("fixture", "contact", "daemon", "daemon.not-running", hint), "fixture", "contact")
		var stage *contactStageFailure
		if !errors.As(err, &stage) || stage.Stage != "daemon" || stage.Reason != "daemon.not-running" {
			t.Fatalf("stage not parsed: %v", err)
		}
		message := contactCheckMessage("", err)
		for _, want := range []string{tr("doctor.daemon"), menuPath("menu.service", "menu.install"), menuPath("menu.service", "menu.start"), "daemon.not-running"} {
			if !strings.Contains(message, want) {
				t.Fatalf("[%s] %q lacks %q", locale, message, want)
			}
		}
		for _, terminal := range []string{"terminal", "терминал", "murmur service", "--data-dir", "--service-name"} {
			if strings.Contains(strings.ToLower(message), terminal) {
				t.Fatalf("[%s] window sends the person to a terminal: %q", locale, message)
			}
		}
		if record := newActionFailure("peer.check", "contact", err, time.Now()); record.Code != "daemon.not-running" {
			t.Fatalf("record code %q", record.Code)
		}

		_, err = parseContactCheck(stageFailureReply("fixture", "contact", "broker", "broker.unreachable", ""), "fixture", "contact")
		if message := contactCheckMessage("", err); !strings.Contains(message, tr("doctorReason.serverUnreachable")) || !strings.Contains(message, tr("doctor.broker")) || !strings.Contains(message, "broker.unreachable") {
			t.Fatalf("[%s] Server stage: %q", locale, message)
		}
		// A new engine reason is still named by its stage and code.
		_, err = parseContactCheck(stageFailureReply("fixture", "contact", "peers", "peers.brand-new", ""), "fixture", "contact")
		if message := contactCheckMessage("", err); !strings.Contains(message, tr("doctor.peers")) || !strings.Contains(message, "peers.brand-new") {
			t.Fatalf("[%s] unknown reason: %q", locale, message)
		}
	}
	// The window hides the hint; diagnostics keep it word for word.
	d := &Doctor{}
	if err := json.Unmarshal(stageFailureReply("fixture", "contact", "daemon", "daemon.not-running", hint), d); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-time.Minute)
	copied := decodeDiagnostics(t, diagnosticsSnapshot{doctor: d, doctorAt: at})
	if copied.Doctor == nil || copied.Doctor.Stages[1].FixHint != hint || copied.DoctorCollectedAt != at.UTC().Format(time.RFC3339) {
		t.Fatalf("diagnostics changed the doctor snapshot: %#v %q", copied.Doctor, copied.DoctorCollectedAt)
	}
}

func TestContactCheckRejectsAnInconsistentStageAndNamesOtherCauses(t *testing.T) {
	defer setLocale(currentLocale())
	setLocale(localeEnglish)
	reply := stageFailureReply("fixture", "contact", "daemon", "daemon.not-running", "")
	inconsistent := []byte(strings.Replace(string(reply), `"reason":"daemon.not-running","replyMsgId"`, `"reason":"broker.unreachable","replyMsgId"`, 1))
	if string(inconsistent) == string(reply) {
		t.Fatal("fixture did not change")
	}
	_, err := parseContactCheck(inconsistent, "fixture", "contact")
	var stage *contactStageFailure
	if errors.As(err, &stage) || err == nil {
		t.Fatalf("inconsistent answer accepted as a cause: %v", err)
	}
	if got := contactCheckMessage("", err); got != tr("peer.checkFailed")+" "+codeSuffix("doctor.peer-result-invalid") {
		t.Fatalf("invalid answer text %q", got)
	}
	if got := contactCheckMessage("", errContactNotSelected); got != tr("peer.notSelected") {
		t.Fatalf("not selected %q", got)
	}
	crash := newCLIFailure([]byte("Error: boom\nNode.js v22.22.3\n"), errors.New("exit status 1"), nil)
	if got := contactCheckMessage("", crash); got != cliCrashText() {
		t.Fatalf("crash %q", got)
	}
	if got := contactCheckMessage("peer.checkTimeout", nil); got != tr("peer.checkTimeout", contactTimeoutSeconds) {
		t.Fatalf("timeout %q", got)
	}
}
