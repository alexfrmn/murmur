package main

import "time"

// stageLabel intentionally omits raw doctor details. Exact reasons remain in
// copied diagnostics, while the menu stays readable and avoids identifiers and
// internal paths.
func stageLabel(d *Doctor, id string) string {
	for _, s := range d.Stages {
		if s.ID != id {
			continue
		}
		label := map[string]string{"ok": tr("stage.ok"), "warn": tr("stage.warn"), "fail": tr("stage.fail"), "skip": tr("stage.skip")}[s.State]
		if label == "" {
			label = tr("stage.unknown")
		}
		if s.ElapsedMs > 0 {
			label = tr("stage.elapsed", label, s.ElapsedMs)
		}
		return label
	}
	return tr("stage.missing")
}

func recentLinesForStatus(status *Status) []string {
	var lines []string
	if status == nil {
		return []string{tr("recent.unavailable")}
	}
	for _, d := range status.Deliveries {
		if d.Direction != "inbound" {
			continue
		}
		lines = append(lines, tr("recent.message", displayEventTime(d.At)))
		if len(lines) == 3 {
			break
		}
	}
	if len(lines) == 0 && status.Inbox.Total != nil && *status.Inbox.Total == 0 {
		lines = append(lines, tr("recent.none"))
	}
	if len(lines) == 0 {
		lines = append(lines, tr("recent.unavailable"))
	}
	return lines
}

// Raw timestamp fields remain in diagnostics; display only parsed values.
func displayEventTime(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return tr("time.unknown")
	}
	return parsed.Format(time.RFC3339)
}

func boolText(v *bool) string {
	if v == nil {
		return tr("bool.unknown")
	}
	if *v {
		return tr("bool.yes")
	}
	return tr("bool.no")
}
