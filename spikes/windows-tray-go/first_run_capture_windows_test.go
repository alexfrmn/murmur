//go:build windows

package main

import (
	"os"
	"testing"
)

func TestFirstRunCapture(t *testing.T) {
	mode := os.Getenv("MURMUR_CAPTURE_FIRST_RUN")
	if mode == "" {
		t.Skip("manual native screenshot harness")
	}
	setLocale(os.Getenv("MURMUR_CAPTURE_LOCALE"))
	if mode == "node-before" {
		tell(tr("onboarding.title"), tr("onboarding.noRuntime", tr("binding.noNode")))
		return
	}
	if mode == "node-after" {
		_ = askYesNo("Murmur", tr("firstRun.nodeRequired"))
		return
	}
	if mode == "before" {
		_, err := showNativeGuide()
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	result, err := showFirstRunWindow(setLocale)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("selected=%d locale=%s", result, currentLocale())
}
