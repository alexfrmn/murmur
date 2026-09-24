package main

import (
	"strings"
	"unicode"
	"unicode/utf16"
)

// Identity, measured state and independent signals precede detail. A long CLI
// reason must never push the product name or unread/update information offscreen.
func statusTooltip(v Verdict, pendingCount int, updateAvailable bool) string {
	state := tr("tip.unknown")
	switch v.Level {
	case LevelRed:
		state = tr("tip.failed")
	case LevelYellow:
		state = tr("tip.attention")
	case LevelGreen:
		state = tr("tip.ready")
	}
	tip := "Murmur — " + state
	if v.Unread {
		if pendingCount < 0 {
			pendingCount = 0
		}
		tip += tr("tip.pending", pendingCount)
	}
	if updateAvailable {
		tip += tr("tip.update")
	}
	if v.Reason != "" {
		tip += ": " + v.Reason
	}
	return boundedTooltip(tip)
}

func boundedTooltip(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	// NOTIFYICONDATAW counts UTF-16 code units, not Unicode code points.
	if len(utf16.Encode([]rune(value))) <= 127 {
		return value
	}
	used := 0
	var result strings.Builder
	for _, r := range value {
		units := 1
		if r > 0xffff {
			units = 2
		}
		if used+units > 124 {
			break
		}
		result.WriteRune(r)
		used += units
	}
	return result.String() + "..."
}
