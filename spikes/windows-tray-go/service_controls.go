package main

// Origins of a Service the engine could not confirm as this installation's own.
const (
	serviceOriginPrevious = "previous" // left by another Murmur installation: a pilot or an earlier version
	serviceOriginForeign  = "foreign"  // the bound name is taken by a program that is not Murmur
)

// serviceOrigin separates the two unknown states a person can act on from any other unknown.
func serviceOrigin(s *Status) string {
	if s == nil || s.Service.State != "unknown" {
		return ""
	}
	switch s.Service.Detail {
	case "service.previous-installation":
		return serviceOriginPrevious
	case "service.foreign-image":
		return serviceOriginForeign
	}
	return ""
}

// Keep lifecycle ownership separate from connection health: an unmanaged Service
// may be connected, paused, or have waiting messages, but cannot be started/stopped here.
func serviceControls(s *Status, ready, admin bool) (enabled bool, state, hint string) {
	if s != nil && s.Service.State == "running-unmanaged" {
		return false, tr("menu.serviceUnmanaged"), tr("menu.serviceUnmanagedTooltip")
	}
	switch serviceOrigin(s) {
	case serviceOriginPrevious:
		return false, tr("menu.servicePrevious"), tr("menu.servicePreviousTooltip")
	case serviceOriginForeign:
		return false, tr("menu.serviceForeign"), tr("menu.serviceForeignTooltip")
	}
	if !admin {
		hint = tr("menu.serviceElevationTooltip")
	}
	return ready && s != nil, "", hint
}

// serviceRequest turns a Service menu action into the CLI call for the observed Service: its
// arguments, a question to confirm first, or a one-sentence refusal. A Service of a previous
// Murmur installation is replaced only after the person agrees, by one command that removes it
// and installs this one under a single administrator consent. A name taken by another program
// is never touched. No arguments and no refusal means there is nothing left to do.
func serviceRequest(s *Status, action string) (args []string, question, refusal string) {
	switch serviceOrigin(s) {
	case serviceOriginPrevious:
		if action == "install" || action == "replace" {
			return []string{"service", "install", "--replace-previous"}, tr("menu.replacePreviousConfirm"), ""
		}
		return nil, "", tr("menu.servicePreviousTooltip")
	case serviceOriginForeign:
		return nil, "", tr("menu.serviceForeignTooltip")
	}
	if action == "replace" || s == nil {
		return nil, "", ""
	}
	if enabled, _, hint := serviceControls(s, true, true); !enabled {
		return nil, "", hint
	}
	if action == "uninstall" {
		return []string{"service", "uninstall"}, tr("menu.uninstallConfirm"), ""
	}
	return []string{"service", action}, "", ""
}
