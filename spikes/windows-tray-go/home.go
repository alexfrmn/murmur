package main

import (
	"encoding/json"
	"errors"
)

type homeRow struct{ Text, Action string }

func homeRows(s *Status, statusErr error, assistant string) ([5]homeRow, homeRow) {
	rows := [5]homeRow{
		{tr("home.identityProblem"), "identity"}, {tr("home.serviceProblem"), "check"},
		{tr("home.serverProblem"), "check"}, {tr("home.contactsProblem"), "invite"}, {tr("home.assistantProblem"), "assistant"},
	}
	next := homeRow{tr("home.nextCheck"), "check"}
	var se *statusError
	if errors.As(statusErr, &se) && se.code == "profile.not-configured" {
		rows = [5]homeRow{{tr("home.identityMissing"), "setup"}, {tr("home.serviceMissing"), "setup"}, {tr("home.serverMissing"), "setup"}, {tr("home.contactsMissing"), "invite"}, {tr("home.assistantMissing"), "assistant"}}
		return rows, homeRow{tr("home.nextInvite"), "invite"}
	}
	if statusErr != nil || validatePinnedStatus(s, "") != nil {
		return rows, next
	}
	rows[0] = homeRow{tr("home.identityReady", plainPreview(s.AgentID, 48)), "identity"}
	switch s.Service.State {
	case "running":
		rows[1] = homeRow{tr("home.serviceReady"), "check"}
	case "running-unmanaged":
		rows[1] = homeRow{tr("home.serviceUnmanaged"), "check"}
	case "stopped":
		rows[1] = homeRow{tr("home.serviceStopped"), "start"}
	case "failed":
		rows[1] = homeRow{tr("home.serviceFailed"), "check"}
	}
	if (s.Service.Manager == "none" || s.Service.Detail == "service.not-installed") && s.Service.State == "stopped" {
		rows[1] = homeRow{tr("home.serviceMissing"), "install"}
	}
	switch serviceOrigin(s) {
	case serviceOriginPrevious:
		rows[1] = homeRow{tr("home.servicePrevious"), "replace"}
	case serviceOriginForeign:
		rows[1] = homeRow{tr("home.serviceForeign"), "foreign"}
	}
	if s.Broker.State == "connected" {
		rows[2] = homeRow{tr("home.serverReady"), "check"}
	}
	if s.Peers.List != nil {
		if len(s.Peers.List) == 0 {
			rows[3] = homeRow{tr("home.contactsMissing"), "invite"}
		} else {
			rows[3] = homeRow{tr("home.contactsReady"), "invite"}
		}
	}
	switch assistant {
	case "ready":
		rows[4] = homeRow{tr("home.assistantReady"), "assistant"}
	case "missing":
		rows[4] = homeRow{tr("home.assistantMissing"), "assistant"}
	}
	switch {
	case rows[1].Action == "replace":
		next = homeRow{tr("home.nextReplace"), "replace"}
	case rows[1].Action == "install":
		next = homeRow{tr("home.nextInstall"), "install"}
	case rows[1].Action == "start":
		next = homeRow{tr("home.nextStart"), "start"}
	case s.Service.State != "running" && s.Service.State != "running-unmanaged", s.Broker.State != "connected":
	case s.Peers.List != nil && len(s.Peers.List) == 0:
		next = homeRow{tr("home.nextInvite"), "invite"}
	case assistant == "missing":
		next = homeRow{tr("home.nextAssistant"), "assistant"}
	case assistant == "ready" && s.Peers.List != nil:
		next = homeRow{tr("home.nextMessages"), "messages"}
	}
	return rows, next
}

// Installation is not connection. Only an unchanged, identity-bound engine
// preview confirms existing Assistant settings; errors remain unknown/problem.
func observeAssistants(cli func(...string) ([]byte, error), profile, identity string) string {
	out, err := cli("clients", "detect", "--json")
	var detected struct {
		Schema  string
		Clients []struct {
			ID        string
			Installed *bool
		}
	}
	if err != nil || json.Unmarshal(out, &detected) != nil || detected.Schema != "murmur.clients/1" || detected.Clients == nil {
		return "problem"
	}
	problem := false
	for _, c := range detected.Clients {
		if assistantNames[c.ID] == "" {
			continue
		}
		if c.Installed == nil {
			problem = true
			continue
		}
		if !*c.Installed {
			continue
		}
		out, err := cli("clients", "preview", "--client", c.ID, "--json")
		if err != nil {
			problem = true
			continue
		}
		p, err := parseAssistantPlan(out, c.ID, profile, identity)
		if err != nil {
			problem = true
			continue
		}
		if p.Action == "unchanged" && (p.WakeHook == nil || p.WakeHook.Action == "unchanged") {
			return "ready"
		}
	}
	if problem {
		return "problem"
	}
	return "missing"
}

// Missing or skipped prerequisites cannot establish a working local connection.
func homeCheckReady(d *Doctor) bool {
	if d == nil {
		return false
	}
	required := map[string]bool{"config": false, "daemon": false, "broker": false}
	for _, stage := range d.Stages {
		if stage.State == "fail" {
			return false
		}
		if _, known := required[stage.ID]; known {
			required[stage.ID] = stage.State == "ok"
		}
	}
	for _, ok := range required {
		if !ok {
			return false
		}
	}
	return true
}
