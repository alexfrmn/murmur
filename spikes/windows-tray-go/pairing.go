package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

const pairingMaxBytes = 16 * 1024

func pairingLine(input string) (string, error) {
	line := strings.TrimSpace(input)
	if len(input) > pairingMaxBytes || len(line) > pairingMaxBytes {
		return "", errors.New(tr("pairing.tooLarge"))
	}
	if !strings.HasPrefix(line, "MURMUR:") || len(line) <= len("MURMUR:") || strings.ContainsAny(line, "\r\n\t ") {
		return "", errors.New(tr("pairing.damaged"))
	}
	return line, nil
}

func pairingFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", errors.New(tr("pairing.fileFailed"))
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, pairingMaxBytes+1))
	if err != nil {
		return "", errors.New(tr("pairing.fileFailed"))
	}
	return pairingLine(string(data))
}

func joinReply(out []byte, identity string) (string, error) {
	var receipt struct{ Schema, AgentID, PeerID, Reply string }
	if json.Unmarshal(out, &receipt) != nil || receipt.Schema != "murmur.join/1" || receipt.AgentID != identity || receipt.PeerID == "" || receipt.PeerID == identity {
		return "", errors.New("pairing.join-invalid")
	}
	return pairingLine(receipt.Reply)
}

// Stable engine errors are mapped without interpolating stderr or pasted text.
func pairingError(err error, reply bool) string {
	switch err.Error() {
	case "onboarding.input-too-large":
		return tr("pairing.tooLarge")
	case "onboarding.invalid-blob", "onboarding.invalid-peer", "onboarding.invalid-peer-key", "onboarding.invalid-broker":
		return tr("pairing.damaged")
	case "onboarding.self-peer", "onboarding.peer-key-conflict":
		if reply {
			return tr("pairing.wrongReply")
		}
	case "onboarding.existing-profile-conflict":
		return tr("pairing.wrongInvite")
	}
	if reply {
		return tr("pairing.addFailed")
	}
	return tr("pairing.joinFailed")
}

func importReply(cli func(...string) ([]byte, error), input func(string, ...string) ([]byte, error), identity, line string) (string, error) {
	line, err := pairingLine(line)
	if err != nil {
		return "", err
	}
	out, err := cli("status", "--json")
	if err != nil {
		return "", errors.New(tr("pairing.identityFailed"))
	}
	s, err := parseStatus(out)
	if err != nil || validatePinnedStatus(s, identity) != nil || identity == "" {
		return "", errors.New(tr("pairing.identityFailed"))
	}
	out, err = input(line, "add-peer", "--reply-stdin", "--json")
	if err != nil {
		return "", errors.New(pairingError(err, true))
	}
	var receipt struct{ Schema, PeerID string }
	if json.Unmarshal(out, &receipt) != nil || receipt.Schema != "murmur.peer/1" || receipt.PeerID == "" || receipt.PeerID == identity {
		return "", errors.New(tr("pairing.addUnconfirmed"))
	}
	// A successful acknowledgement is not connection proof. Confirm the contact
	// exists under the same Identity before offering the separate roundtrip check.
	out, err = cli("status", "--json")
	if err != nil {
		return "", errors.New(tr("pairing.addUnconfirmed"))
	}
	s, err = parseStatus(out)
	if err != nil || validatePinnedStatus(s, identity) != nil {
		return "", errors.New(tr("pairing.addUnconfirmed"))
	}
	for _, peer := range s.Peers.List {
		if peer.AgentID == receipt.PeerID {
			return peer.AgentID, nil
		}
	}
	return "", errors.New(tr("pairing.addUnconfirmed"))
}
