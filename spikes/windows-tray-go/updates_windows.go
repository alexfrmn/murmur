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
	a.mUpdatesRoot = systray.AddMenuItem(tr("updates.root"), tr("updates.rootTooltip"))
	a.mUpdateState = a.mUpdatesRoot.AddSubMenuItem(tr("updates.notChecked"), "")
	a.mUpdateState.Disable()
	a.mUpdateVersion = a.mUpdatesRoot.AddSubMenuItem(tr("updates.current", tr("updates.unknown")), "")
	a.mUpdateVersion.Disable()
	a.mUpdateTime = a.mUpdatesRoot.AddSubMenuItem(tr("updates.noCheck"), "")
	a.mUpdateTime.Disable()
	a.mUpdateReason = a.mUpdatesRoot.AddSubMenuItem("", "")
	a.mUpdateReason.Disable()
	a.mUpdatePage = a.mUpdatesRoot.AddSubMenuItem(tr("updates.open"), tr("updates.openTooltip"))
	a.mUpdatePage.Disable()
	a.mUpdateEnable = a.mUpdatesRoot.AddSubMenuItem(tr("updates.enable"), "")
	a.mUpdateDisable = a.mUpdatesRoot.AddSubMenuItem(tr("updates.disable"), "")
	a.mUpdatePrivacy = a.mUpdatesRoot.AddSubMenuItem(tr("updates.privacy"), tr("updates.privacyTooltip"))
	a.mUpdatePrivacy.Disable()
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
		title = tr("updates.failed")
	}
	if busy {
		title = tr("updates.checking")
	}
	a.mUpdateState.SetTitle(title)
	version := tr("updates.unknown")
	if s != nil && s.CurrentVersion != nil {
		version = *s.CurrentVersion
	}
	a.mUpdateVersion.SetTitle(tr("updates.current", version))
	a.mUpdateTime.SetTitle(s.observation(now))
	reason := ""
	if s != nil {
		reason = updateReasonLabel(s.Reason)
	}
	if err != nil {
		reason = tr("updates.unavailable")
	}
	if os.Getenv("MURMUR_UPDATE_CHECK") == "0" {
		reason = tr("updates.disabledEnv")
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
		a.mUpdateState.SetTitle(tr("updates.openFailed"))
	}
}
