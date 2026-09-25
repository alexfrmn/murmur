package main

import (
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// A stable engine code, as safeError in packages/setup/src/config.ts lets it through.
var cliCodePattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.:-]{0,150}$`)

// "runtime.node-version-unsupported: Use Node.js …": a dotted code followed by a sentence.
var cliCodePrefix = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z0-9_.-]{1,140}): `)

// The policy of the macOS CLIProbe, plus pairing lines: a line that may carry a credential,
// an Invitation or Reply, or a Server address is replaced as a whole, never shortened. A
// file:// URL is a stack frame of this installation, not an address with a credential.
var (
	stderrSecret = regexp.MustCompile(`(?i)(MURMUR:|authorization|token|secret|password|passwd|api[_ -]?key|bearer)`)
	stderrURL    = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*)?://`)
)

func secretLine(line string) bool {
	if stderrSecret.MatchString(line) {
		return true
	}
	for _, m := range stderrURL.FindAllStringSubmatch(line, -1) {
		if !strings.EqualFold(m[1], "file") {
			return true
		}
	}
	return false
}

const (
	stderrLineLimit = 20
	stderrLineRunes = 300
	redactedLine    = "[redacted]"
)

// cliFailure is a CLI run that did not succeed. Code is the engine's stable code: the last
// stderr line when it is one, so Node warnings printed before it no longer hide it. Stderr keeps
// at most stderrLineLimit masked lines for diagnostics; it is never shown in a window.
type cliFailure struct {
	Code     string // "" when the CLI wrote no code: a crash, a kill, a missing Node
	ExitCode int    // -1 when the process reported none
	Stderr   []string
	Omitted  int // stderr lines beyond the limit
	message  string
	causes   []error
}

// Error keeps what callers compared before: the code, or the one stderr line an older engine
// wrote, or the exit status.
func (f *cliFailure) Error() string   { return f.message }
func (f *cliFailure) Unwrap() []error { return f.causes }

func isCLICode(value string) bool {
	return value == "database is locked" || cliCodePattern.MatchString(value)
}

// maskedLine applies the diagnostics policy to one line of CLI or error text.
func maskedLine(line string) string {
	line = strings.TrimSpace(line)
	if cliCodePattern.MatchString(line) {
		return line // a code containing "token" is a code, not a credential
	}
	if secretLine(line) {
		return redactedLine
	}
	return plainPreview(line, stderrLineRunes)
}

func newCLIFailure(stderr []byte, runErr, ctxErr error) *cliFailure {
	f := &cliFailure{ExitCode: -1, message: runErr.Error(), causes: []error{runErr}}
	if ctxErr != nil {
		f.causes = append(f.causes, ctxErr)
	}
	var exit *exec.ExitError
	if errors.As(runErr, &exit) {
		f.ExitCode = exit.ExitCode()
	}
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(string(stderr), "\r\n", "\n"), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return f
	}
	last := lines[len(lines)-1]
	if isCLICode(last) {
		f.Code = last
	} else if m := cliCodePrefix.FindStringSubmatch(last); m != nil {
		f.Code = m[1]
	}
	switch {
	case len(lines) == 1 && !secretLine(last) || isCLICode(last):
		f.message = last
	case f.Code != "":
		f.message = f.Code
	}
	for i, line := range lines {
		if i == stderrLineLimit {
			f.Omitted = len(lines) - stderrLineLimit
			break
		}
		f.Stderr = append(f.Stderr, maskedLine(line))
	}
	return f
}

// cliCrashed: the CLI failed without naming a code. The window says so in a sentence; the
// masked stderr goes to diagnostics.
func cliCrashed(err error) bool {
	var f *cliFailure
	return errors.As(err, &f) && f.Code == ""
}

// failureCode is the stable code behind an action error, or "" when there is none.
func failureCode(err error) string {
	if err == nil {
		return ""
	}
	var f *cliFailure
	if errors.As(err, &f) {
		return f.Code
	}
	var stage *contactStageFailure
	if errors.As(err, &stage) {
		if isCLICode(stage.Reason) {
			return stage.Reason
		}
		return ""
	}
	if isCLICode(err.Error()) {
		return err.Error()
	}
	return ""
}

// codeSuffix is the "(code: …)" ending for a sentence that names an unknown cause.
func codeSuffix(code string) string { return tr("error.code", code) }

// actionFailure is the last failed menu action, kept for "Copy diagnostics" with its time.
type actionFailure struct {
	Action        string   `json:"action"`
	Target        string   `json:"target,omitempty"`
	At            string   `json:"at"`
	Error         string   `json:"error"`
	Code          string   `json:"code,omitempty"`
	ExitCode      *int     `json:"exitCode,omitempty"`
	Stderr        []string `json:"stderr,omitempty"`
	StderrOmitted int      `json:"stderrOmittedLines,omitempty"`
}

func newActionFailure(action, target string, err error, at time.Time) *actionFailure {
	r := &actionFailure{Action: action, Target: target, At: at.UTC().Format(time.RFC3339), Error: maskedError(err), Code: failureCode(err)}
	var f *cliFailure
	if errors.As(err, &f) {
		exit := f.ExitCode
		r.ExitCode, r.Stderr, r.StderrOmitted = &exit, f.Stderr, f.Omitted
	}
	return r
}

func maskedError(err error) string {
	if err == nil {
		return ""
	}
	return maskedLine(err.Error())
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// diagnosticsSnapshot is what "Copy diagnostics" puts on the clipboard. Doctor output keeps its
// fixHint and engineering words: this text is read by the people who debug.
type diagnosticsSnapshot struct {
	status     *Status
	statusErr  error
	doctor     *Doctor
	doctorErr  error
	doctorAt   time.Time
	actionErr  error
	lastFailed *actionFailure
}

func diagnosticsJSON(s diagnosticsSnapshot, now time.Time) ([]byte, error) {
	doctorAt := ""
	if !s.doctorAt.IsZero() {
		doctorAt = s.doctorAt.UTC().Format(time.RFC3339)
	}
	return json.MarshalIndent(map[string]any{
		"collectedAt":       now.UTC().Format(time.RFC3339),
		"status":            s.status,
		"statusError":       errText(s.statusErr),
		"doctor":            s.doctor,
		"doctorError":       errText(s.doctorErr),
		"doctorCollectedAt": doctorAt,
		"actionError":       maskedError(s.actionErr),
		"lastFailedAction":  s.lastFailed,
	}, "", "  ")
}

// codedError keeps a tray step code as the error text while diagnostics still reach the CLI
// failure underneath it.
type codedError struct {
	code  string
	cause error
}

func (e *codedError) Error() string { return e.code }
func (e *codedError) Unwrap() error { return e.cause }
