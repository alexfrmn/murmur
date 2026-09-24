package main

import (
	"strings"
	"testing"
	"unicode/utf16"
)

func TestTooltipNamesProductStateAndSignalsBeforeLongDetail(t *testing.T) {
	previous := currentLocale()
	t.Cleanup(func() { setLocale(previous) })
	for _, language := range []string{localeEnglish, localeRussian} {
		setLocale(language)
		for _, level := range []Level{LevelGrey, LevelYellow, LevelGreen, LevelRed} {
			got := statusTooltip(Verdict{Level: level, Unread: true, Reason: strings.Repeat("😀", 200)}, 3, true)
			if !strings.HasPrefix(got, "Murmur — ") || !strings.Contains(got, tr("tip.pending", 3)) || !strings.Contains(got, tr("tip.update")) {
				t.Fatal(got)
			}
			if len(utf16.Encode([]rune(got))) > 127 || !strings.HasSuffix(got, "...") {
				t.Fatal(got)
			}
		}
	}
}

func TestTooltipControlCharactersCannotTerminateProductState(t *testing.T) {
	got := statusTooltip(Verdict{Level: LevelGreen, Reason: "reason\x00\r\nmore"}, 0, false)
	if strings.ContainsAny(got, "\x00\r\n") || !strings.HasPrefix(got, "Murmur — ") {
		t.Fatal(got)
	}
}
