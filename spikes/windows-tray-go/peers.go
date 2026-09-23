package main

import (
	"strings"
	"unicode"
)

const peerMenuLimit = 20

func peerExchangeKey(paired *bool) string {
	if paired == nil {
		return "peer.unchecked"
	}
	if !*paired {
		return "peer.failed"
	}
	return "peer.verified"
}

// The indicator describes runtime readiness. Each row retains its own proof state.
func peerLinesForStatus(s *Status) []string {
	if s == nil || s.Peers.List == nil {
		return []string{tr("peer.unavailable")}
	}
	if len(s.Peers.List) == 0 {
		return []string{tr("status.noPeers")}
	}
	var lines []string
	for i, peer := range s.Peers.List {
		if i == peerMenuLimit {
			lines = append(lines, tr("peer.more", len(s.Peers.List)-peerMenuLimit))
			break
		}
		id := strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, peer.AgentID)
		if runes := []rune(id); len(runes) > 100 {
			id = string(runes[:100]) + "…"
		}
		lines = append(lines, strings.ReplaceAll(id, "&", "&&")+" — "+tr(peerExchangeKey(peer.Paired)))
	}
	return lines
}
