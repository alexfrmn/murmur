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
		return "", errors.New("peer.not-selected")
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
	return "", invalid
}
