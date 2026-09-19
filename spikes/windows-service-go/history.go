//go:build windows

package main

import (
	"fmt"
	"time"
)

func measuredRestarts(st runState, now time.Time) (int, int64, error) {
	started, err := time.Parse(time.RFC3339Nano, st.StartedAt)
	if err != nil || st.HostPID <= 0 || started.After(now) {
		return 0, 0, fmt.Errorf("service.history-origin-unavailable")
	}
	window := now.Sub(started)
	if window > time.Hour {
		window = time.Hour
	}
	cutoff := now.Add(-window)
	count := 0
	for _, event := range st.Restarts {
		if event.After(now) {
			return 0, 0, fmt.Errorf("service.history-event-in-future")
		}
		if !event.Before(cutoff) {
			count++
		}
	}
	return count, window.Milliseconds(), nil
}
