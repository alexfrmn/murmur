package main

import (
	"encoding/json"
	"errors"
)

const contactTimeoutSeconds = 10

func checkContact(cli func(...string) ([]byte, error), identity, peer string) (string, error) {
	out, err := cli("status", "--json")
	if err != nil {
		return "", err
	}
	s, err := parseStatus(out)
	if err == nil {
		err = validatePinnedStatus(s, identity)
	}
	if err != nil {
		return "", err
	}
	found := false
	for _, p := range s.Peers.List {
		if p.AgentID == peer && peer != "" {
			found = true
		}
	}
	if !found {
		return "", errContactNotSelected
	}
	out, err = cli("doctor", "--peer", peer, "--timeout", "10000", "--json")
	if err != nil {
		return "", err
	}
	return parseContactCheck(out, s.AgentID, peer)
}

func parseContactCheck(out []byte, identity, peer string) (string, error) {
	var d Doctor
	var proof struct {
		PeerCheck *struct{ PeerID, State, LastExchangeAt, RequestMsgID, ReplyMsgID, Reason string }
	}
	invalid := errors.New("doctor.peer-result-invalid")
	if json.Unmarshal(out, &d) != nil || json.Unmarshal(out, &proof) != nil || !schemaKnown(d.Schema, doctorSchema) || d.AgentID != identity || identity == "" || proof.PeerCheck == nil || proof.PeerCheck.PeerID != peer || peer == "" || validateDoctor(&d) != nil {
		return "", invalid
	}
	age, ok := ageOf(d.GeneratedAt)
	if !ok || age > maxStatusAge || age < -clockSkewTolerance {
		return "", invalid
	}
	p := proof.PeerCheck
	for _, stage := range d.Stages {
		if stage.ID != "roundtrip" {
			continue
		}
		if p.State == "connected" && stage.State == "ok" && p.RequestMsgID != "" && p.ReplyMsgID != "" {
			age, valid := ageOf(p.LastExchangeAt)
			if valid && age <= maxStatusAge && age >= -clockSkewTolerance {
				return "peer.checkConnected", nil
			}
		}
		if p.State == "failed" && p.Reason == "roundtrip.timeout" && stage.State == "fail" && stage.Reason == "roundtrip.timeout" {
			return "peer.checkTimeout", nil
		}
	}
	// An earlier stage stopped the check: the engine names it in the stages and repeats its
	// reason in peerCheck. Anything less consistent is not evidence of a cause.
	for _, stage := range d.Stages {
		if stage.State == "fail" {
			if p.State == "failed" && p.Reason == stage.Reason && stage.Reason != "" {
				return "", &contactStageFailure{Stage: stage.ID, Reason: stage.Reason}
			}
			break
		}
	}
	return "", invalid
}

var errContactNotSelected = errors.New("peer.not-selected")

// contactStageFailure is a Contact check that the doctor answered for this Identity and
// Contact, stopped at Stage with the engine's Reason code.
type contactStageFailure struct{ Stage, Reason string }

func (e *contactStageFailure) Error() string { return e.Stage + ": " + e.Reason }

// doctorReasonKeys turn a doctor reason code into a sentence with a tray action. The engine's
// fixHint (a terminal command) stays in --json and diagnostics; a window never shows it.
var doctorReasonKeys = map[string]string{
	"config.missing":            "doctorReason.configMissing",
	"config.file-invalid":       "doctorReason.configFile",
	"config.owner-mismatch":     "doctorReason.configFile",
	"config.identity-invalid":   "doctorReason.configInvalid",
	"config.broker-url-invalid": "doctorReason.configInvalid",
	"config.keys-invalid":       "doctorReason.configInvalid",
	"config.peers-invalid":      "doctorReason.configInvalid",
	"config.peer-invalid":       "doctorReason.configInvalid",
	"daemon.not-running":        "doctorReason.serviceNotRunning",
	"daemon.store-unverified":   "doctorReason.serviceUnverified",
	"broker.unreachable":        "doctorReason.serverUnreachable",
	"broker.unauthorized":       "doctorReason.serverUnauthorized",
	"peers.unknown":             "doctorReason.contactUnknown",
	"peers.none":                "doctorReason.noContacts",
	"roundtrip.timeout":         "doctorReason.contactTimeout",
	"database is locked":        "doctorReason.busy",
}

func doctorReasonText(reason string) string {
	switch key := doctorReasonKeys[reason]; key {
	case "":
		return tr("doctorReason.unknown")
	case "doctorReason.serviceNotRunning":
		return tr(key, menuPath("menu.service", "menu.install"), menuPath("menu.service", "menu.start"))
	case "doctorReason.serviceUnverified":
		return tr(key, menuPath("menu.service", "menu.stop"), menuPath("menu.service", "menu.start"))
	default:
		return tr(key)
	}
}

func doctorStageName(id string) string {
	for _, stage := range doctorStages {
		if stage.id == id {
			return tr(stage.messageKey)
		}
	}
	return tr("stage.unknown")
}

// contactCheckMessage is the window text for "Check connection with …": the result, or the
// stage and the code that stopped the check.
func contactCheckMessage(key string, err error) string {
	if err == nil {
		if key == "peer.checkTimeout" {
			return tr(key, contactTimeoutSeconds)
		}
		return tr(key)
	}
	var stage *contactStageFailure
	switch {
	case errors.As(err, &stage):
		code := stage.Reason
		if !isCLICode(code) {
			code = "doctor.reason-invalid"
		}
		return tr("peer.checkStageFailed", doctorStageName(stage.Stage), doctorReasonText(stage.Reason), code)
	case errors.Is(err, errContactNotSelected):
		return tr("peer.notSelected")
	case cliCrashed(err):
		return cliCrashText()
	}
	if code := failureCode(err); code != "" {
		return tr("peer.checkFailed") + " " + codeSuffix(code)
	}
	return tr("peer.checkFailed")
}
