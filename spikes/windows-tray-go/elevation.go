package main

import (
	"errors"
	"strings"
)

var (
	errElevationCancelled = errors.New("elevation-cancelled")
	errElevatedTimeout    = errors.New("elevated-timeout")
)

// elevatedCommandLine joins arguments for ShellExecuteEx the way CommandLineToArgvW (and the C
// runtime Node uses) splits them back: quote when needed, double the backslashes that precede a
// quote or the closing quote, escape embedded quotes. Profiles live under paths with spaces and
// Cyrillic letters, so this is not optional.
func elevatedCommandLine(args []string) string {
	parts := make([]string, 0, len(args))
	for _, arg := range args {
		parts = append(parts, quoteWindowsArg(arg))
	}
	return strings.Join(parts, " ")
}

func quoteWindowsArg(arg string) string {
	if arg != "" && !strings.ContainsAny(arg, " \t\n\v\"") {
		return arg
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for _, r := range arg {
		switch r {
		case '\\':
			slashes++
			continue
		case '"':
			b.WriteString(strings.Repeat(`\`, 2*slashes+1))
			b.WriteByte('"')
		default:
			b.WriteString(strings.Repeat(`\`, slashes))
			b.WriteRune(r)
		}
		slashes = 0
	}
	b.WriteString(strings.Repeat(`\`, 2*slashes))
	b.WriteByte('"')
	return b.String()
}
