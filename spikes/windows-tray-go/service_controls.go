package main

// Keep lifecycle ownership separate from connection health: an unmanaged Service
// may be connected, paused, or have waiting messages, but cannot be started/stopped here.
func serviceControls(s *Status, ready, admin bool) (enabled bool, state, hint string) {
	if s != nil && s.Service.State == "running-unmanaged" {
		return false, tr("menu.serviceUnmanaged"), tr("menu.serviceUnmanagedTooltip")
	}
	if !admin {
		hint = tr("menu.serviceElevationTooltip")
	}
	return ready && s != nil, "", hint
}
