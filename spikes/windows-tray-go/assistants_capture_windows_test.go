//go:build windows

package main

import (
	"os"
	"testing"
)

// Native visual fixture only. No CLI calls and no Assistant settings are read or written.
func TestAssistantCapture(t *testing.T) {
	mode := os.Getenv("MURMUR_CAPTURE_ASSISTANT")
	if mode == "" {
		t.Skip("manual native visual fixture")
	}
	setLocale(os.Getenv("MURMUR_CAPTURE_LOCALE"))
	switch mode {
	case "before-choice":
		askYesNo(tr("onboarding.title"), tr("onboarding.clientsAsk", "Claude Code, Codex"))
	case "before-conflict":
		tell(tr("onboarding.title"), tr("onboarding.clientFailed", "Claude Code", "client.murmur-entry-conflict"))
	case "choice":
		showAssistantChoices([]string{"claude-code", "codex-cli"})
	case "replace":
		showAssistantReplacement("Claude Code", "work-identity")
	default:
		t.Fatal("unknown capture mode")
	}
}
