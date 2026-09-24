//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

func serviceActionMessage(err error) string {
	var statusErr *statusError
	if errors.As(err, &statusErr) && statusErr.code == "profile.not-configured" {
		return tr("menu.needIdentity")
	}
	for _, key := range []string{"menu.serviceUnmanagedTooltip", "action.elevationCancelled", "action.elevatedTimeout"} {
		if err.Error() == tr(key) {
			return tr(key)
		}
	}
	return tr("menu.serviceActionFailed")
}

func (a *app) connectSelectedAssistants() {
	a.mu.Lock()
	if a.actionBusy {
		a.mu.Unlock()
		return
	}
	a.actionBusy = true
	expected := a.pinnedAgent
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.actionBusy = false; a.mu.Unlock(); a.refreshStatus() }()
	b, err := selectedCLI()
	if err != nil || !isProfile(b.Profile) {
		tell(tr("assistants.title"), tr("menu.needIdentity"))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	out, err := runSetupCLI(ctx, b, b.arguments([]string{"status", "--json"})[1:]...)
	var fresh *Status
	if err == nil {
		fresh, err = parseStatus(out)
	}
	if err == nil {
		err = validatePinnedStatus(fresh, expected)
	}
	if err != nil {
		tell(tr("assistants.title"), tr("menu.identityUnconfirmed"))
		return
	}
	connected := connectAssistants(onboardingSteps{
		chooseClients: showAssistantChoices, confirmClientReplacement: showAssistantReplacement,
		confirm: askYesNo, inform: tell,
		cli: func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, args...) },
	}, b.Profile, fresh.AgentID)
	message := tr("assistants.noneConnected")
	if len(connected) > 0 {
		message = tr("assistants.connected", strings.Join(connected, ", "))
	}
	tell(tr("assistants.title"), message)
}

func (a *app) openLogs() {
	b, err := selectedCLI()
	if err != nil || !isProfile(b.Profile) {
		tell(tr("menu.serviceLogs"), tr("menu.needIdentity"))
		return
	}
	a.mu.Lock()
	expected := a.pinnedAgent
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), mutationTimeout)
	defer cancel()
	out, err := runSetupCLI(ctx, b, b.arguments([]string{"status", "--json"})[1:]...)
	var fresh *Status
	if err == nil {
		fresh, err = parseStatus(out)
	}
	if err == nil {
		err = validatePinnedStatus(fresh, expected)
	}
	if err != nil {
		tell(tr("menu.serviceLogs"), tr("menu.identityUnconfirmed"))
		return
	}
	args := []string{"logs", "path", "--data-dir", b.Profile, "--json"}
	if b.Service != "" {
		args = append(args, "--service-name", b.Service)
	}
	out, err = runSetupCLI(ctx, b, args...)
	logDir, parseErr := parseNativeLogDirectory(out, b, fresh.AgentID)
	if err != nil || parseErr != nil {
		tell(tr("menu.serviceLogs"), tr("menu.logsUnavailable"))
		return
	}
	info, err := os.Stat(logDir)
	if err != nil || !info.IsDir() {
		tell(tr("menu.serviceLogs"), tr("menu.logsUnavailable"))
		return
	}
	verb, _ := windows.UTF16PtrFromString("open")
	target, err := windows.UTF16PtrFromString(logDir)
	if err == nil {
		err = windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL)
	}
	if err != nil {
		tell(tr("menu.serviceLogs"), tr("menu.logsUnavailable"))
	}
}
