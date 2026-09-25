package main

import (
	"errors"
	"os"
	"regexp"
	"strings"
)

// onboardingSteps are the user-facing and system actions of first-profile setup. The flow is
// plain logic over them, so it is tested without dialogs, a CLI or a UAC prompt.
type onboardingSteps struct {
	chooseClients            func([]string) []string
	confirmClientReplacement func(string, string) bool
	pickInvitation           func() (string, bool) // pasted line; file is an optional input in the UI
	showReply                func(string)
	cliInput                 func(string, ...string) ([]byte, error)
	confirm                  func(title, text string) bool
	inform                   func(title, text string)
	cli                      func(args ...string) ([]byte, error)   // runs the bundle CLI as the user
	elevated                 func(args ...string) error             // runs the bundle CLI after one UAC prompt
	failed                   func(action, target string, err error) // keeps a failure for diagnostics
}

func (s onboardingSteps) reportFailure(action, target string, err error) {
	if s.failed != nil {
		s.failed(action, target, err)
	}
}

type onboardingResult struct {
	AgentID, Profile, Reply string
	ServiceInstalled        bool
	Clients                 []string
}

var errOnboardingCancelled = errors.New("onboarding-cancelled")

var agentIDPart = regexp.MustCompile(`[^a-z0-9]+`)

// defaultAgentID gives a readable, valid identity (^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$) from the
// Windows user name, so a new user is never asked to invent one.
func defaultAgentID(user string) string {
	name := strings.Trim(agentIDPart.ReplaceAllString(strings.ToLower(user), "-"), "-")
	if name == "" {
		name = "user"
	}
	if len(name) > 40 {
		name = strings.Trim(name[:40], "-")
	}
	return "agent-" + name
}

// Join uses an in-memory line and returns an in-memory Reply; no exchange file.
func runOnboarding(s onboardingSteps, profile, agentID string) (onboardingResult, error) {
	r := onboardingResult{AgentID: agentID, Profile: profile}
	invitation, ok := s.pickInvitation()
	if !ok {
		return r, errOnboardingCancelled
	}
	line, err := pairingLine(invitation)
	if err != nil {
		return r, err
	}
	out, err := s.cliInput(line, "join", "--agent-id", agentID, "--invite-stdin", "--json", "--data-dir", profile)
	if err != nil {
		s.reportFailure("pairing.join", "", err)
		return r, errors.New(pairingError(err, false))
	}
	r.Reply, err = joinReply(out, agentID)
	if err != nil {
		return r, errors.New(tr("pairing.joinUnconfirmed"))
	}
	s.showReply(r.Reply)

	if s.confirm(tr("onboarding.title"), tr("onboarding.serviceAsk")) {
		if err := s.elevated("service", "install", "--json", "--data-dir", profile); err != nil {
			s.reportFailure("service.install", "", err)
			s.inform(tr("onboarding.title"), tr("onboarding.serviceFailed", err))
		} else {
			r.ServiceInstalled = true
		}
	}

	r.Clients = connectAssistants(s, profile, agentID)
	return r, nil
}

func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
