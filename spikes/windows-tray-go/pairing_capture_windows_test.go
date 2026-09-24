//go:build windows

package main

import (
	"os"
	"testing"
)

// Synthetic visual proof only: no engine, clipboard, profile, or Service writes.
func TestNativePairingAcceptance(t *testing.T) {
	if os.Getenv("MURMUR_PAIRING_PROOF") != "1" {
		t.Skip("native visual acceptance only")
	}
	setLocale(os.Getenv("MURMUR_PROOF_LOCALE"))
	switch os.Getenv("MURMUR_PROOF_MODE") {
	case "invite":
		showPairingInput(false, "")
	case "reply-input":
		showPairingInput(true, "")
	case "reply-output":
		showPairingReply("MURMUR:synthetic-visual-proof-only-not-a-real-reply", func(string) error { return nil })
	case "success":
		showPairingSuccess("Anna")
	case "error":
		showPairingInput(false, "truncated-message")
	default:
		t.Fatal("unknown proof mode")
	}
}
