//go:build windows

package main

import (
	"context"
	"os"
	"time"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
)

func (a *app) setupUpdates() {
	root := systray.AddMenuItem("Updates", "Declared stable release; separate from message delivery health")
	a.mUpdateState = root.AddSubMenuItem("Updates: not checked", "")
	a.mUpdateState.Disable()
	a.mUpdateVersion = root.AddSubMenuItem("Declared version: unknown", "")
	a.mUpdateVersion.Disable()
	a.mUpdateTime = root.AddSubMenuItem("No network check recorded", "")
	a.mUpdateTime.Disable()
	a.mUpdateReason = root.AddSubMenuItem("", "")
	a.mUpdateReason.Disable()
	a.mUpdatePage = root.AddSubMenuItem("Open release page", "Opens GitHub only on this click; nothing is installed")
	a.mUpdatePage.Disable()
	a.mUpdateEnable = root.AddSubMenuItem("Enable update checks", "")
	a.mUpdateDisable = root.AddSubMenuItem("Disable update checks", "")
	privacy := root.AddSubMenuItem("Checks contact GitHub and reveal your IP", "No profile, keys or credentials are sent; at most every six hours")
	privacy.Disable()
	a.updateRequests = make(chan bool, 1)
}

// One owner serializes checks/preferences independently of status/service work.
// Schedule from completion, so a timer never fires just before the CLI cache expires.
func (a *app) updateLoop() {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		var preference *bool
		select {
		case <-timer.C:
		case enabled := <-a.updateRequests:
			preference = &enabled
		}
		a.mu.Lock()
		a.updateBusy = true
		a.mu.Unlock()
		a.renderUpdateState()
		var err error
		if preference != nil {
			ctx, cancel := context.WithTimeout(context.Background(), cliTimeout)
			err = setUpdatesEnabled(ctx, *preference)
			cancel()
		}
		var result *updateSnapshot
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), cliTimeout)
			result, err = fetchUpdates(ctx)
			cancel()
		}
		a.mu.Lock()
		a.updates = result
		a.updateErr = err
		a.updateBusy = false
		s, statusErr := a.status, a.statusErr
		a.mu.Unlock()
		a.render(resolve(s, statusErr))
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(updateInterval)
	}
}

func (a *app) renderUpdateState() {
	a.mu.Lock()
	s, err, busy := a.updates, a.updateErr, a.updateBusy
	a.mu.Unlock()
	now := time.Now()
	title := s.title(now)
	if err != nil {
		title = "Updates: unable to check"
	}
	if busy {
		title = "Checking updates…"
	}
	a.mUpdateState.SetTitle(title)
	version := "unknown"
	if s != nil && s.CurrentVersion != nil {
		version = *s.CurrentVersion
	}
	a.mUpdateVersion.SetTitle("Declared version: " + version)
	a.mUpdateTime.SetTitle(s.observation(now))
	reason := ""
	if s != nil {
		reason = s.Reason
	}
	if err != nil {
		reason = "CLI result unavailable; no automatic retry"
	}
	if os.Getenv("MURMUR_UPDATE_CHECK") == "0" {
		reason = "Disabled by MURMUR_UPDATE_CHECK=0"
	}
	a.mUpdateReason.SetTitle(reason)
	if reason == "" {
		a.mUpdateReason.Hide()
	} else {
		a.mUpdateReason.Show()
	}
	a.mUpdatePage.Disable()
	if !busy && err == nil && s.page(now) != "" {
		a.mUpdatePage.Enable()
	}
	a.mUpdateEnable.Disable()
	a.mUpdateDisable.Disable()
	if !busy && os.Getenv("MURMUR_UPDATE_CHECK") != "0" {
		if s == nil || !s.Enabled {
			a.mUpdateEnable.Enable()
		}
		if s == nil || s.Enabled {
			a.mUpdateDisable.Enable()
		}
	}
}
func (a *app) requestUpdatePreference(enabled bool) {
	a.mu.Lock()
	busy := a.updateBusy
	a.mu.Unlock()
	if busy || os.Getenv("MURMUR_UPDATE_CHECK") == "0" {
		return
	}
	select {
	case a.updateRequests <- enabled:
	default:
	}
}
func (a *app) openUpdatePage() {
	a.mu.Lock()
	page := a.updates.page(time.Now())
	busy := a.updateBusy
	a.mu.Unlock()
	if page == "" || busy {
		return
	}
	// Literal ShellExecute URL, never a shell command or downloaded executable.
	verb, _ := windows.UTF16PtrFromString("open")
	target, _ := windows.UTF16PtrFromString(page)
	if err := windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL); err != nil {
		a.mUpdateState.SetTitle("Could not open the release page")
	}
}
