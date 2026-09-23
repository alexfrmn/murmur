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
	a.mUpdateCheck = a.mUpdatesRoot.AddSubMenuItem(tr("updates.checkNow"), tr("updates.checkNowTooltip"))
	a.mUpdatePage = a.mUpdatesRoot.AddSubMenuItem(tr("updates.open"), tr("updates.openTooltip"))
	a.mUpdatePage.Disable()
	a.mUpdateEnable = a.mUpdatesRoot.AddSubMenuItem(tr("updates.enable"), "")
	a.mUpdateDisable = a.mUpdatesRoot.AddSubMenuItem(tr("updates.disable"), "")
	a.mUpdatePrivacy = a.mUpdatesRoot.AddSubMenuItem(tr("updates.privacy"), tr("updates.privacyTooltip"))
	a.mUpdatePrivacy.Disable()
	// A nil request checks with the existing preferences; only explicit enable
	// and disable actions carry a preference change.
	a.updateRequests = make(chan *bool, 1)
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
		case preference = <-a.updateRequests:
		}
		a.mu.Lock()
		a.updateBusy = true
		a.mu.Unlock()
		a.renderUpdateState()
		result, err := performUpdateRequest(context.Background(), preference, cliTimeout)
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
	a.mUpdateCheck.Disable()
	if busy {
		a.mUpdateCheck.SetTitle(tr("updates.checking"))
	} else {
		a.mUpdateCheck.SetTitle(tr("updates.checkNow"))
		a.mUpdateCheck.Enable()
	}
	a.mUpdateVersion.SetTitle(tr("updates.current", displayedVersion(s)))
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
	view := updateToggleView(s, busy, os.Getenv("MURMUR_UPDATE_CHECK") == "0")
	for _, item := range []struct {
		menu *systray.MenuItem
		show bool
	}{{a.mUpdateEnable, view.showEnable}, {a.mUpdateDisable, view.showDisable}} {
		item.menu.Disable()
		if !item.show {
			item.menu.Hide()
			continue
		}
		item.menu.Show()
		if view.clickable {
			item.menu.Enable()
		}
	}
}
func (a *app) requestUpdatePreference(enabled bool) {
	a.requestUpdates(&enabled)
}
func (a *app) requestUpdates(preference *bool) {
	a.mu.Lock()
	busy := a.updateBusy
	a.mu.Unlock()
	// A manual request may read the CLI's disabled state. The binding preserves
	// MURMUR_UPDATE_CHECK=0, and the CLI returns before any network request.
	// Preference changes cannot override that environment-level opt-out.
	if busy || (preference != nil && os.Getenv("MURMUR_UPDATE_CHECK") == "0") {
		return
	}
	select {
	case a.updateRequests <- preference:
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
