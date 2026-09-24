//go:build windows

package main

func showAssistantReplacement(name, identity string) bool {
	controls := []inviteControl{
		{200, 0x82, 16, 12, 298, 65, 0, tr("assistants.replace", name, identity)},
		{2, 0x80, 166, 90, 148, 26, 0x10001, tr("assistants.keepButton")},
		{1, 0x80, 16, 90, 140, 26, 0x10000, tr("assistants.replaceButton")},
	}
	return runInviteDialog(inviteDialogTemplate(tr("assistants.title"), 132, controls), func(hwnd, id uintptr) bool {
		if id != 1 {
			return false
		}
		user32.NewProc("EndDialog").Call(hwnd, 1)
		return true
	}) == 1
}

func showAssistantChoices(found []string) []string {
	available := map[string]bool{}
	for _, id := range found {
		available[id] = true
	}
	controls := []inviteControl{
		{200, 0x82, 16, 12, 298, 28, 0, tr("assistants.heading")},
	}
	for i, id := range []string{"claude-code", "codex-cli"} {
		style := uint32(0x10003) // native checkbox, initially unchecked
		label := assistantNames[id]
		if !available[id] {
			style |= 0x08000000
			label += " — " + tr("assistants.notDetected")
		}
		controls = append(controls, inviteControl{uint16(101 + i), 0x80, 16, uint16(50 + i*32), 298, 24, style, label})
	}
	controls = append(controls,
		inviteControl{203, 0x82, 16, 118, 298, 30, 0, tr("assistants.desktopUnsupported")},
		inviteControl{204, 0x82, 16, 158, 298, 28, 0, tr("assistants.restartHint")},
		inviteControl{1, 0x80, 16, 198, 198, 26, 0x10001, tr("assistants.connect")},
		inviteControl{2, 0x80, 222, 198, 92, 26, 0x10000, tr("invite.cancel")},
	)
	selected := []string{}
	result := runInviteDialog(inviteDialogTemplate(tr("assistants.title"), 240, controls), func(hwnd, id uintptr) bool {
		if id != 1 {
			return false
		}
		for i, client := range []string{"claude-code", "codex-cli"} {
			control, _, _ := user32.NewProc("GetDlgItem").Call(hwnd, uintptr(101+i))
			checked, _, _ := user32.NewProc("SendMessageW").Call(control, 0xf0, 0, 0)
			if available[client] && checked == 1 {
				selected = append(selected, client)
			}
		}
		user32.NewProc("EndDialog").Call(hwnd, 1)
		return true
	})
	if result != 1 {
		return nil
	}
	return selected
}
