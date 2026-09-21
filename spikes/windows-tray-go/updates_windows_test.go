//go:build windows

package main

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestManualUpdateRequestRoutesUnderEnvironmentOverride(t *testing.T) {
	log := bindUpdateRequestFixture(t, disabledUpdateFixture(), false)
	a := app{updateRequests: make(chan *bool, 1)}
	a.requestUpdates(nil)
	var preference *bool
	select {
	case preference = <-a.updateRequests:
	default:
		t.Fatal("manual request did not reach the CLI queue under the environment override")
	}
	if preference != nil {
		t.Fatal("manual request attempted to change the preference")
	}
	snapshot, err := performUpdateRequest(context.Background(), preference, 10*time.Second)
	if err != nil || snapshot == nil || snapshot.Enabled || snapshot.Reason != "updates.disabled" {
		t.Fatal(snapshot, err)
	}
	commands, err := os.ReadFile(log)
	if err != nil || string(commands) != "check\n" {
		t.Fatal("manual route changed a preference or ran another command", string(commands), err)
	}
	for _, enabled := range []bool{false, true} {
		a.requestUpdatePreference(enabled)
		select {
		case <-a.updateRequests:
			t.Fatal("preference change queued under the environment override")
		default:
		}
	}
	a.updateBusy = true
	a.requestUpdates(nil)
	select {
	case <-a.updateRequests:
		t.Fatal("manual request queued while an update was already running")
	default:
	}
}
