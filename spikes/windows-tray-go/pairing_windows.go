//go:build windows

package main

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"unsafe"
)

func pairingField(hwnd uintptr) string {
	// Read one extra byte worth of UTF-16 units so a too-long paste is rejected,
	// never silently accepted as a truncated invitation.
	buf := make([]uint16, pairingMaxBytes+2)
	user32.NewProc("GetDlgItemTextW").Call(hwnd, 101, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf)
}
func showPairingInput(reply bool, initial string) (string, bool) {
	title, hint, submit := tr("pairing.pasteInvite"), tr("pairing.inviteHint"), tr("pairing.join")
	if reply {
		title, hint, submit = tr("pairing.pasteReply"), tr("pairing.replyHint"), tr("pairing.add")
	}
	controls := []inviteControl{
		{200, 0x82, 16, 12, 408, 42, 0, hint},
		{101, 0x81, 16, 58, 408, 100, 0xA110C4, initial},
		{201, 0x82, 16, 166, 408, 42, 0, ""},
		{3, 0x80, 16, 214, 120, 26, 0x10000, tr("pairing.openFile")},
		{1, 0x80, 144, 214, 164, 26, 0x10001, submit},
		{2, 0x80, 316, 214, 108, 26, 0x10000, tr("invite.cancel")},
	}
	var line string
	result := runInviteDialog(nativeDialogTemplate(title, 440, 254, controls), func(hwnd, id uintptr) bool {
		if id == 0 {
			user32.NewProc("SendMessageW").Call(dialogItem(hwnd, 101), 0xC5, 65536, 0)
			return true
		}
		if id == 3 {
			path, ok := fileDialog(false, tr("pairing.openFile"), "")
			if !ok {
				return true
			}
			value, err := pairingFile(path)
			if err != nil {
				setNativeText(dialogItem(hwnd, 201), err.Error())
			} else {
				setNativeText(dialogItem(hwnd, 101), value)
				setNativeText(dialogItem(hwnd, 201), "")
			}
			return true
		}
		if id != 1 {
			return false
		}
		var err error
		line, err = pairingLine(pairingField(hwnd))
		if err != nil {
			setNativeText(dialogItem(hwnd, 201), err.Error())
			return true
		}
		user32.NewProc("EndDialog").Call(hwnd, 1)
		return true
	})
	return line, result == 1
}

func showPairingReply(line string, copyLine func(string) error) {
	message := tr("pairing.replyCopied")
	if copyLine(line) != nil {
		message = tr("pairing.copyFailed")
	}
	controls := []inviteControl{
		{200, 0x82, 16, 12, 408, 38, 0, tr("pairing.sendReply")},
		{101, 0x81, 16, 56, 408, 100, 0xA118C4, line},
		{201, 0x82, 16, 164, 408, 32, 0, message},
		{3, 0x80, 16, 208, 278, 26, 0x10001, tr("pairing.copyAgain")},
		{2, 0x80, 302, 208, 122, 26, 0x10000, tr("invite.close")},
	}
	runInviteDialog(nativeDialogTemplate(tr("pairing.yourReply"), 440, 250, controls), func(hwnd, id uintptr) bool {
		if id != 3 {
			return false
		}
		message := tr("pairing.replyCopied")
		if copyLine(line) != nil {
			message = tr("pairing.copyFailed")
		}
		setNativeText(dialogItem(hwnd, 201), message)
		return true
	})
}
func showPairingSuccess(peer string) bool {
	controls := []inviteControl{
		{200, 0x82, 16, 12, 328, 48, 0, tr("pairing.added", plainPreview(peer, 80))},
		{1, 0x80, 16, 72, 210, 26, 0x10001, tr("pairing.check")},
		{2, 0x80, 234, 72, 110, 26, 0x10000, tr("invite.close")},
	}
	return runInviteDialog(nativeDialogTemplate(tr("peer.connections"), 360, 114, controls), func(hwnd, id uintptr) bool {
		if id != 1 {
			return false
		}
		user32.NewProc("EndDialog").Call(hwnd, 1)
		return true
	}) == 1
}
func (a *app) pasteColleagueReply() {
	a.mu.Lock()
	if a.actionBusy {
		a.mu.Unlock()
		return
	}
	a.actionBusy = true
	expected := a.pinnedAgent
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.actionBusy = false; a.mu.Unlock(); a.refreshStatus() }()
	b, err := selectedCLI()
	if err != nil || expected == "" {
		tell(tr("pairing.pasteReply"), tr("pairing.identityFailed"))
		return
	}
	line, ok := showPairingInput(true, "")
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), mutationTimeout)
	defer cancel()
	selected, err := selectedCLI()
	if err != nil || selected != b {
		tell(tr("pairing.pasteReply"), tr("pairing.identityFailed"))
		return
	}
	cli := func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, b.arguments(args)[1:]...) }
	input := func(line string, args ...string) ([]byte, error) {
		selected, err := selectedCLI()
		if err != nil || selected != b {
			return nil, errors.New("pairing.selection-changed")
		}
		return runSetupCLIInput(ctx, b, line, b.arguments(args)[1:]...)
	}
	peer, err := importReply(cli, input, expected, line)
	if err != nil {
		tell(tr("pairing.pasteReply"), err.Error())
		return
	}
	if savePendingReplyPreference(a.preferencesPath, b.Profile, expected, false) != nil {
		tell(tr("pairing.pasteReply"), tr("pairing.preferenceFailed"))
	}
	a.refreshStatus()
	if showPairingSuccess(peer) {
		go a.checkPeer(peer)
	}
}
