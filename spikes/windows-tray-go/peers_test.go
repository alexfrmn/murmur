package main

import (
	"strings"
	"testing"
)

func TestPeerDetailsKeepProofSeparateFromReadiness(t *testing.T) {
	previous := currentLocale()
	t.Cleanup(func() { setLocale(previous) })
	setLocale(localeEnglish)
	s := load(t, "status-peers-unchecked.json")
	if v := resolve(s, nil); v.Level != LevelGreen || v.Code != "ok" {
		t.Fatalf("healthy runtime should be ready: %#v", v)
	}
	lines := peerLinesForStatus(s)
	if len(lines) != 2 || !strings.Contains(lines[0], "Connection has not been checked yet") || s.Peers.List[0].Paired != nil {
		t.Fatalf("unchecked proof was hidden or fabricated: %v", lines)
	}
	yes, no := true, false
	s.Peers.List[0].Paired, s.Peers.List[1].Paired = &yes, &no
	setLocale(localeRussian)
	lines = peerLinesForStatus(s)
	if !strings.Contains(lines[0], "Связь проверена") || !strings.Contains(lines[1], "Связь проверить не удалось") {
		t.Fatalf("localized proof states lost: %v", lines)
	}
	if v := resolve(s, nil); v.Level != LevelYellow {
		t.Fatalf("measured mismatch must still warn: %#v", v)
	}
}

func TestPeerMenuIsBoundedAndPreservesUnknownLists(t *testing.T) {
	if len(peerLinesForStatus(nil)) != 1 {
		t.Fatal("missing status needs a visible unknown row")
	}
	s := load(t, "status-peers-unchecked.json")
	p := s.Peers.List[0]
	p.AgentID = "peer\n\r\t&value"
	s.Peers.List = nil
	for i := 0; i < peerMenuLimit+3; i++ {
		s.Peers.List = append(s.Peers.List, p)
	}
	lines := peerLinesForStatus(s)
	if len(lines) != peerMenuLimit+1 || strings.ContainsAny(lines[0], "\n\r\t") || !strings.Contains(lines[0], "&&value") {
		t.Fatalf("unsafe or unbounded peer rows: %v", lines)
	}
	if !strings.Contains(lines[len(lines)-1], "3") {
		t.Fatal("overflow must be explicit")
	}
}

func TestPeerConnectionUsesRecentExchangeBeforeLegacyProof(t *testing.T) {
	for connection, key := range map[string]string{"connected": "peer.connected", "stale": "peer.stale", "unverified": "peer.unchecked"} {
		yes := true
		if got := peerConnectionKey(Peer{Connection: connection, Paired: &yes}); got != key {
			t.Fatalf("%s: got %s, expected %s", connection, got, key)
		}
	}
}
