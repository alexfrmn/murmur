package main

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
		return lines
	}
	for _, d := range status.Deliveries {
		if d.Direction != "inbound" {
			continue
		}
		lines = append(lines, tr("recent.message", d.At))
		if len(lines) == 3 {
			break
		}
	}
	if len(lines) == 0 && status.Inbox.Total != nil && *status.Inbox.Total == 0 {
		lines = append(lines, tr("recent.none"))
	}
	return lines
}
