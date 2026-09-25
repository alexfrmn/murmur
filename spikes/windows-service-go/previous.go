package main

import "strings"

// What a Service registered under the bound name runs when it is not this helper's own.
// The value crosses into status JSON as foreignKind; the CLI decides from it whether the
// Service may be replaced.
const (
	foreignPreviousInstallation = "previous-installation"
	foreignNotMurmur            = "not-murmur"
)

// previousInstallationImage reports whether an already decomposed SCM image is the
// registration a Murmur helper makes for this name: <absolute path>\murmur-svc.exe run <name>.
// The caller has already ruled out this installation's own helper, so a match means another
// installation (a pilot or an earlier version). The file is identified by its registration
// only and is never executed: it may be gone, and running it would run another program as
// administrator.
func previousInstallationImage(args []string, name string) bool {
	if len(args) != 3 || args[1] != "run" || args[2] != name {
		return false
	}
	exe := args[0]
	cut := strings.LastIndexAny(exe, `\/`)
	return cut > 0 && absoluteWindowsPath(exe) && strings.EqualFold(exe[cut+1:], "murmur-svc.exe")
}

// A drive path (C:\...) or a UNC path (\\server\share\...). A relative name would be
// resolved against System32 by the service host and says nothing about Murmur.
func absoluteWindowsPath(value string) bool {
	if len(value) >= 3 && value[1] == ':' && (value[2] == '\\' || value[2] == '/') {
		c := value[0] | 0x20
		return c >= 'a' && c <= 'z'
	}
	if !strings.HasPrefix(value, `\\`) {
		return false
	}
	// \\server\share\file: a UNC name without a server and a share is not a location.
	parts := strings.FieldsFunc(value[2:], func(r rune) bool { return r == '\\' || r == '/' })
	return len(parts) >= 3 && value[2] != '\\' && value[2] != '/'
}
