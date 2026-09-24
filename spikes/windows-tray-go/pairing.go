package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"strings"
	"unicode"
)

const pairingMaxBytes = 16 * 1024

// pairingToken is one Invitation or Reply line. The engine writes base64url;
// v2.10 and v2.11 wrote standard base64 (+, / and = padding), which it still accepts.
var pairingToken = regexp.MustCompile(`MURMUR:[A-Za-z0-9_+/-]+={0,2}`)

// pairingLine takes the line out of what the person pasted. A line copied from
// a messenger or mail often brings the text around it (a greeting, a signature,
// quotes), so the token is kept and the rest is ignored. The same line twice (a
// message and its quote) is one line; two different lines are ambiguous and
// rejected. A line broken by wrapping leaves a truncated token, which the engine
// rejects as a damaged blob before it changes anything.
func pairingLine(input string) (string, error) {
	if len(input) > pairingMaxBytes {
		return "", errors.New(tr("pairing.tooLarge"))
	}
	// Messengers may insert invisible format characters (zero-width space, soft
	// hyphen) into a long line; they are never part of it.
	input = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, input)
	tokens := pairingToken.FindAllString(input, -1)
	if len(tokens) == 0 {
		return "", errors.New(tr("pairing.damaged"))
	}
	for _, token := range tokens[1:] {
		if token != tokens[0] {
			return "", errors.New(tr("pairing.damaged"))
		}
	}
	return tokens[0], nil
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
