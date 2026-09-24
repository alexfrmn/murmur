//go:build windows

package main

import (
	"context"
	"strings"
	"time"
)

func menuText(value string) string { return strings.ReplaceAll(value, "&", "&&") }

func (a *app) startMenuActions() {
	for i, item := range a.mHome {
		go func() {
			for range item.ClickedCh {
				a.homeClicks <- i
			}
		}()
	}
	for i, item := range a.mPeerChecks {
		go func() {
			for range item.ClickedCh {
				a.peerClicks <- i
			}
		}()
	}
}

func (a *app) renderHome() {
	b, bindingErr := selectedCLI()
	a.mu.Lock()
	assistant := a.assistantState
	if a.status == nil || a.assistantIdentity != a.status.AgentID {
		assistant = "problem"
	}
	rows, next := homeRows(a.status, a.statusErr, assistant)
	for i, row := range rows {
		a.homeActions[i] = row.Action
		a.mHome[i].SetTitle(menuText(row.Text))
	}
	if bindingErr == nil && a.status != nil && pendingReplyPreference(a.preferencesPath, b.Profile, a.status.AgentID) {
		next = homeRow{tr("pairing.nextReply"), "reply"}
	}
	a.nextAction = next.Action
	a.mNext.SetTitle(next.Text)
	a.mu.Unlock()
}

func (a *app) performHomeAction(action string) {
	switch action {
	case "reply":
		a.pasteColleagueReply()
	case "setup":
		a.showFirstRun()
	case "identity":
		a.openExistingProfile()
	case "invite":
		a.inviteColleague()
	case "assistant":
		a.connectSelectedAssistants()
		a.mu.Lock()
		a.assistantChecked = time.Time{}
		a.mu.Unlock()
		a.refreshAssistantState()
	case "install":
		a.runCLI("service", "install")
	case "start":
		a.runCLI("service", "start")
	case "messages":
		a.openMessages()
	case "check":
		a.refreshDoctor()
		a.refreshStatus()
		a.mu.Lock()
		d, err := a.doctor, a.doctorErr
		a.mu.Unlock()
		message := tr("home.checkFailed")
		if err == nil && homeCheckReady(d) {
			message = tr("home.checkReady")
		}
		tell(tr("menu.checkNow"), message)
	}
}

func (a *app) refreshAssistantState() {
	b, err := selectedCLI()
	if err != nil {
		return
	}
	a.mu.Lock()
	if a.status == nil || a.pinnedAgent == "" || a.assistantBusy || (a.assistantBinding == b && a.assistantIdentity == a.pinnedAgent && time.Since(a.assistantChecked) < time.Minute) {
		a.mu.Unlock()
		return
	}
	expected := a.pinnedAgent
	a.assistantBusy = true
	a.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), doctorTimeout)
		defer cancel()
		cli := func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, b.arguments(args)[1:]...) }
		state := "problem"
		out, err := cli("status", "--json")
		if err == nil {
			s, err := parseStatus(out)
			if err == nil && validatePinnedStatus(s, expected) == nil {
				state = observeAssistants(cli, b.Profile, expected)
			}
		}
		selected, selectionErr := selectedCLI()
		a.mu.Lock()
		a.assistantBusy = false
		if selectionErr == nil && selected == b && a.pinnedAgent == expected {
			a.assistantState, a.assistantIdentity, a.assistantBinding, a.assistantChecked = state, expected, b, time.Now()
		}
		a.mu.Unlock()
		a.renderHome()
	}()
}

func (a *app) renderPeers() {
	a.mu.Lock()
	defer a.mu.Unlock()
	var peers []Peer
	if a.status != nil {
		peers = a.status.Peers.List
	}
	for i, item := range a.mPeers {
		if i >= len(peers) {
			item.Hide()
			a.peerIDs[i] = ""
			continue
		}
		p := peers[i]
		a.peerIDs[i] = p.AgentID
		name := menuText(plainPreview(p.AgentID, 80))
		item.SetTitle(name)
		item.Show()
		a.mPeerStates[i].SetTitle(tr(peerConnectionKey(p)))
		a.mPeerChecks[i].SetTitle(tr("peer.check", name))
		if a.peerChecking[p.AgentID] {
			a.mPeerStates[i].SetTitle(tr("peer.checking"))
			a.mPeerChecks[i].Disable()
		} else {
			a.mPeerChecks[i].Enable()
		}
	}
	switch {
	case peers == nil:
		a.mPeerOverflow.SetTitle(tr("peer.unavailable"))
		a.mPeerOverflow.Show()
	case len(peers) == 0:
		a.mPeerOverflow.SetTitle(tr("status.noPeers"))
		a.mPeerOverflow.Show()
	case len(peers) > peerMenuLimit:
		a.mPeerOverflow.SetTitle(tr("peer.more", len(peers)-peerMenuLimit))
		a.mPeerOverflow.Show()
	default:
		a.mPeerOverflow.Hide()
	}
}

func (a *app) checkPeer(peer string) {
	if peer == "" {
		return
	}
	a.mu.Lock()
	if a.peerChecking[peer] {
		a.mu.Unlock()
		return
	}
	a.peerChecking[peer] = true
	expected := a.pinnedAgent
	a.mu.Unlock()
	a.renderPeers()
	defer func() { a.mu.Lock(); delete(a.peerChecking, peer); a.mu.Unlock(); a.refreshStatus() }()
	b, err := selectedCLI()
	key := "peer.checkFailed"
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), doctorTimeout)
		defer cancel()
		cli := func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, b.arguments(args)[1:]...) }
		result, checkErr := checkContact(cli, expected, peer)
		if checkErr == nil {
			key = result
		}
	}
	message := tr(key)
	if key == "peer.checkTimeout" {
		message = tr(key, contactTimeoutSeconds)
	}
	tell(tr("peer.check", plainPreview(peer, 80)), message)
}
