package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// onboardingSteps are the user-facing and system actions of first-profile setup. The flow is
// plain logic over them, so it is tested without dialogs, a CLI or a UAC prompt.
type onboardingSteps struct {
	pickInvitation func() (string, bool)                 // file dialog; false when cancelled
	pickReply      func(suggested string) (string, bool) // save dialog; false when cancelled
	confirm        func(title, text string) bool         // yes/no
	inform         func(title, text string)              // ok
	revealFile     func(path string)                     // show the reply in Explorer and copy its path
	cli            func(args ...string) ([]byte, error)  // runs the bundle CLI as the user
	elevated       func(args ...string) error            // runs the bundle CLI after one UAC prompt
	exists         func(path string) bool
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

// runOnboarding: invitation file -> join (profile, identity, reply file) -> reply shown and copied
// -> one UAC prompt for the service -> detected Claude Code / Codex connected after one
// confirmation. Every step after join is optional and reported; nothing is silently skipped.
func runOnboarding(s onboardingSteps, profile, agentID, replyDir string) (onboardingResult, error) {
	r := onboardingResult{AgentID: agentID, Profile: profile}
	invite, ok := s.pickInvitation()
	if !ok {
		return r, errOnboardingCancelled
	}
	suggested := filepath.Join(replyDir, "murmur-reply-"+agentID+".txt")
	for {
		reply, ok := s.pickReply(suggested)
		if !ok {
			return r, errOnboardingCancelled
		}
		if !s.exists(reply) {
			r.Reply = reply
			break
		}
		// The CLI never overwrites a reply file; ask for another name instead of failing.
		s.inform(tr("onboarding.title"), tr("onboarding.replyExists", reply))
	}
	if _, err := s.cli("join", "--agent-id", agentID, "--invite-file", invite, "--reply-out", r.Reply, "--data-dir", profile); err != nil {
		return r, fmt.Errorf("%s", tr("onboarding.joinFailed", err))
	}
	s.revealFile(r.Reply)
	s.inform(tr("onboarding.title"), tr("onboarding.replySaved", agentID, r.Reply))

	if s.confirm(tr("onboarding.title"), tr("onboarding.serviceAsk")) {
		if err := s.elevated("service", "install", "--json", "--data-dir", profile); err != nil {
			s.inform(tr("onboarding.title"), tr("onboarding.serviceFailed", err))
		} else {
			r.ServiceInstalled = true
		}
	}

	var detected struct {
		Clients []struct {
			ID        string `json:"id"`
			Installed bool   `json:"installed"`
		} `json:"clients"`
	}
	names := map[string]string{"claude-code": "Claude Code", "codex-cli": "Codex"}
	var found []string
	if out, err := s.cli("clients", "detect", "--data-dir", profile); err == nil && json.Unmarshal(out, &detected) == nil {
		for _, c := range detected.Clients {
			if c.Installed && names[c.ID] != "" {
				found = append(found, c.ID)
			}
		}
	}
	if len(found) > 0 {
		labels := make([]string, len(found))
		for i, id := range found {
			labels[i] = names[id]
		}
		if s.confirm(tr("onboarding.title"), tr("onboarding.clientsAsk", strings.Join(labels, ", "))) {
			for _, id := range found {
				if _, err := s.cli("clients", "configure", "--client", id, "--data-dir", profile); err != nil {
					s.inform(tr("onboarding.title"), tr("onboarding.clientFailed", names[id], err))
					continue
				}
				r.Clients = append(r.Clients, names[id])
			}
		}
	}
	return r, nil
}

func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
