//go:build windows

package main

import (
	"testing"
	"time"
)

func TestRestartHistoryReportsActualWindow(t *testing.T) {
	now := time.Date(2026, 9, 19, 19, 0, 0, 0, time.UTC)
	st := runState{HostPID: 123, StartedAt: now.Add(-10 * time.Minute).Format(time.RFC3339), Restarts: []time.Time{now.Add(-11 * time.Minute), now.Add(-5 * time.Minute)}}
	count, window, err := measuredRestarts(st, now)
	if err != nil || count != 1 || window != int64(10*time.Minute/time.Millisecond) {
		t.Fatalf("%d %d %v", count, window, err)
	}
	st.StartedAt = now.Add(-2 * time.Hour).Format(time.RFC3339)
	count, window, err = measuredRestarts(st, now)
	if err != nil || count != 2 || window != int64(time.Hour/time.Millisecond) {
		t.Fatalf("%d %d %v", count, window, err)
	}
	st.HostPID = 0
	if _, _, err = measuredRestarts(st, now); err == nil {
		t.Fatal("legacy history without host accepted")
	}
	st.HostPID = 123
	st.Restarts = append(st.Restarts, now.Add(time.Second))
	if _, _, err = measuredRestarts(st, now); err == nil {
		t.Fatal("future event accepted")
	}
}
