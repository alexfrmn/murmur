package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func contactReply(identity, peer string, success bool) []byte {
	stage := map[string]any{"id": "roundtrip", "state": "ok"}
	proof := map[string]any{"peerId": peer, "state": "connected", "lastExchangeAt": time.Now().UTC().Format(time.RFC3339), "requestMsgId": "request", "replyMsgId": "reply"}
	if !success {
		stage["state"] = "fail"
		stage["reason"] = "roundtrip.timeout"
		proof["state"] = "failed"
		proof["reason"] = "roundtrip.timeout"
	}
	out, _ := json.Marshal(map[string]any{"schema": doctorSchema, "agentId": identity, "generatedAt": time.Now().UTC().Format(time.RFC3339), "stages": []any{stage}, "peerCheck": proof})
	return out
}
func TestContactCheckPinsIdentityAndSelectedPeerBeforeSending(t *testing.T) {
	s := load(t, "status-green.json")
	identity, peer := s.AgentID, s.Peers.List[0].AgentID
	for _, success := range []bool{false, true} {
		var calls []string
		key, err := checkContact(func(args ...string) ([]byte, error) {
			calls = append(calls, strings.Join(args, " "))
			if args[0] == "status" {
				return statusBytes(t, identity), nil
			}
			return contactReply(identity, peer, success), nil
		}, identity, peer)
		want := "peer.checkTimeout"
		if success {
			want = "peer.checkConnected"
		}
		if err != nil || key != want || len(calls) != 2 || calls[1] != "doctor --peer "+peer+" --timeout 10000 --json" {
			t.Fatal(key, err, calls)
		}
	}
	calls := 0
	_, err := checkContact(func(...string) ([]byte, error) { calls++; return statusBytes(t, identity), nil }, identity, "not-a-contact")
	if err == nil || calls != 1 {
		t.Fatal("unknown Contact sent traffic", calls, err)
	}
}
func TestContactCheckRefusesWrongPeerAndTransportOnlySuccess(t *testing.T) {
	for _, data := range [][]byte{contactReply("other", "contact", true), contactReply("fixture", "other", true), []byte(strings.Replace(string(contactReply("fixture", "contact", true)), `"replyMsgId":"reply"`, `"replyMsgId":""`, 1))} {
		if _, err := parseContactCheck(data, "fixture", "contact"); err == nil {
			t.Fatal("unbound or missing reply accepted")
		}
	}
}
