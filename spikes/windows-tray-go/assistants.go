package main

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
)

var assistantNames = map[string]string{"claude-code": "Claude Code", "codex-cli": "Codex"}
var assistantPlanID = regexp.MustCompile(`^[a-f0-9]{64}$`)

type assistantPlan struct {
	Schema, Client, ConfigPath, AgentID, DataDir, Action, PlanID string
	WakeHook                                                     *struct{ Action string }
}

func validAssistantAction(action string) bool {
	return action == "add" || action == "replace" || action == "unchanged"
}

// Match lexical normalization performed by the engine, without resolving aliases
// or changing the selected path sent to CLI (which also selects the Service).
func sameAssistantProfile(a, b string) bool {
	return filepath.IsAbs(a) && filepath.IsAbs(b) && filepath.Clean(a) == filepath.Clean(b)
}

func parseAssistantPlan(out []byte, client, profile, identity string) (assistantPlan, error) {
	var p assistantPlan
	if json.Unmarshal(out, &p) != nil || p.Schema != "murmur.client-plan/1" || p.Client != client || !sameAssistantProfile(p.DataDir, profile) || p.AgentID != identity || !filepath.IsAbs(p.ConfigPath) || !assistantPlanID.MatchString(p.PlanID) || !validAssistantAction(p.Action) || (p.WakeHook != nil && !validAssistantAction(p.WakeHook.Action)) {
		return p, errors.New("client.plan-invalid")
	}
	return p, nil
}

// Configure only the engine's previewed plan. A stale plan is never refreshed and
// accepted silently: the user must choose again after seeing the failure.
func configureAssistant(s onboardingSteps, client, profile, identity string) error {
	out, err := s.cli("clients", "preview", "--client", client, "--data-dir", profile, "--json")
	if err != nil {
		return err
	}
	plan, err := parseAssistantPlan(out, client, profile, identity)
	if err != nil {
		return err
	}
	replace := plan.Action == "replace" || (plan.WakeHook != nil && plan.WakeHook.Action == "replace")
	if replace {
		accepted := false
		if s.confirmClientReplacement != nil {
			accepted = s.confirmClientReplacement(assistantNames[client], identity)
		} else {
			accepted = s.confirm(tr("assistants.title"), tr("assistants.replace", assistantNames[client], identity))
		}
		if !accepted {
			return errOnboardingCancelled
		}
	}
	args := []string{"clients", "configure", "--client", client, "--data-dir", profile, "--plan-id", plan.PlanID, "--json"}
	if replace {
		args = append(args, "--replace")
	}
	out, err = s.cli(args...)
	if err != nil {
		return err
	}
	var result struct {
		Schema, Client, ConfigPath, AgentID, DataDir, PlanID string
		Changed                                              *bool
	}
	if json.Unmarshal(out, &result) != nil || result.Schema != "murmur.client/1" || result.Client != client || result.ConfigPath != plan.ConfigPath || result.AgentID != identity || !sameAssistantProfile(result.DataDir, profile) || result.PlanID != plan.PlanID || result.Changed == nil {
		return errors.New("client.result-invalid")
	}
	return nil
}

// assistantFailureKeys gives every client.* code the engine (packages/setup/src) or this tray
// can return a sentence with an action. assistant_codes_test.go reads the engine sources, so a
// new engine code without a sentence fails the build instead of reaching a person as a shrug.
var assistantFailureKeys = map[string]string{
	"client.plan-stale":              "assistants.stale",
	"client.murmur-entry-conflict":   "assistants.conflictChanged",
	"client.wake-hook-conflict":      "assistants.conflictChanged",
	"client.not-detected":            "assistants.notDetectedError",
	"client.config-path-unverified":  "assistants.pathUnverified",
	"client.config-file-invalid":     "assistants.configFileInvalid",
	"client.config-parse-failed":     "assistants.configParseFailed",
	"client.settings-parse-failed":   "assistants.settingsParseFailed",
	"client.hooks-invalid":           "assistants.hooksInvalid",
	"client.mcp-table-invalid":       "assistants.mcpTableInvalid",
	"client.config-roundtrip-failed": "assistants.roundtripFailed",
	"client.wake-drain-missing":      "assistants.wakeFileMissing",
	"client.plan-invalid":            "assistants.planInvalid",
	"client.result-invalid":          "assistants.resultInvalid",
}

// assistantFailure is one sentence with an action. An unknown stable code is named at the end;
// a CLI that failed without a code is said to have failed, with the details in diagnostics.
func assistantFailure(err error) string {
	if key, ok := assistantFailureKeys[err.Error()]; ok {
		return tr(key)
	}
	if cliCrashed(err) {
		return cliCrashText()
	}
	if code := failureCode(err); code != "" {
		return tr("assistants.failed") + " " + codeSuffix(code)
	}
	return tr("assistants.failed")
}

// cliCrashText points at the menu path where the details are.
func cliCrashText() string {
	return tr("action.cliCrashed", menuPath("menu.doctor", "menu.copy"))
}

// menuPath names a tray menu item as a person finds it: "Service → Install".
func menuPath(keys ...string) string {
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, strings.TrimRight(tr(key), "…"))
	}
	return strings.Join(parts, " → ")
}

func connectAssistants(s onboardingSteps, profile, identity string) []string {
	var detected struct {
		Schema  string
		Clients []struct {
			ID        string
			Installed bool
		}
	}
	out, err := s.cli("clients", "detect", "--data-dir", profile)
	if err == nil && (json.Unmarshal(out, &detected) != nil || detected.Schema != "murmur.clients/1") {
		err = errors.New("client.detect-invalid")
	}
	if err != nil {
		s.reportFailure("assistants.detect", "", err)
		message := tr("assistants.detectFailed")
		if cliCrashed(err) {
			message = cliCrashText()
		} else if code := failureCode(err); code != "" {
			message += " " + codeSuffix(code)
		}
		s.inform(tr("assistants.title"), message)
		return nil
	}
	found := []string{}
	available := map[string]bool{}
	for _, c := range detected.Clients {
		if c.Installed && assistantNames[c.ID] != "" {
			available[c.ID] = true
		}
	}
	for _, id := range []string{"claude-code", "codex-cli"} {
		if available[id] {
			found = append(found, id)
		}
	}
	selected := []string{}
	if s.chooseClients != nil {
		selected = s.chooseClients(found)
	} else if len(found) > 0 {
		labels := []string{}
		for _, id := range found {
			labels = append(labels, assistantNames[id])
		}
		if s.confirm(tr("assistants.title"), tr("onboarding.clientsAsk", strings.Join(labels, ", "))+"\n\n"+tr("assistants.desktopUnsupported")) {
			selected = found
		}
	} else {
		s.inform(tr("assistants.title"), tr("assistants.none")+"\n\n"+tr("assistants.desktopUnsupported"))
	}
	connected := []string{}
	seen := map[string]bool{}
	for _, id := range selected {
		if !available[id] || seen[id] {
			continue
		}
		seen[id] = true
		if err := configureAssistant(s, id, profile, identity); err != nil {
			if errors.Is(err, errOnboardingCancelled) {
				s.inform(tr("assistants.title"), tr("assistants.kept", assistantNames[id]))
			} else {
				s.reportFailure("assistants.connect", id, err)
				s.inform(tr("assistants.title"), tr("assistants.clientFailed", assistantNames[id], assistantFailure(err)))
			}
			continue
		}
		connected = append(connected, assistantNames[id])
	}
	return connected
}
