//go:build windows

package main

// Значок Murmur для Windows. Состояние видно цветом, детали —
// в меню. Данные берутся только из murmur status --json и murmur doctor --json.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
)

const (
	statusInterval = 3 * time.Second
	cliTimeout     = 10 * time.Second
	// doctor гоняет тестовое сообщение по кругу, поэтому по таймеру он не крутится:
	// проверка, которая шлёт трафик каждые тридцать секунд, меняет то, что измеряет.
	doctorTimeout = 30 * time.Second
	// Сколько строк истории держать в меню. Пункты создаются один раз при старте.
	historyLines = 4
	// Сколько последних входящих показывать строками.
	recentLines = 3
)

// Этапы doctor в порядке, заданном лейном. Значок держит их список сам, чтобы строки
// меню существовали до первого успешного вызова и показывали «не проверялось».
var doctorStages = []struct{ id, messageKey string }{
	{"config", "doctor.config"},
	{"daemon", "doctor.daemon"},
	{"broker", "doctor.broker"},
	{"peers", "doctor.peers"},
	{"roundtrip", "doctor.roundtrip"},
	{"wake", "doctor.wake"},
}

type app struct {
	mu                                                       sync.Mutex
	status                                                   *Status
	statusErr                                                error
	pinnedAgent                                              string
	actionBusy                                               bool
	actionResult                                             string
	actionErr                                                error
	mActionStatus                                            *systray.MenuItem
	mWakeStatus                                              *systray.MenuItem
	doctor                                                   *Doctor
	doctorErr                                                error
	updates                                                  *updateSnapshot
	updateErr                                                error
	updateBusy                                               bool
	updateRequests                                           chan *bool
	preferencesPath                                          string
	guideSignal                                              *launcherGuideSignal
	instance                                                 *trayInstance
	mUpdateState, mUpdateVersion, mUpdateTime, mUpdateReason *systray.MenuItem
	mUpdateCheck, mUpdatePage, mUpdateEnable, mUpdateDisable *systray.MenuItem
	mUpdatesRoot, mUpdatePrivacy                             *systray.MenuItem

	mHeader, mDoctorRoot, mRecentHeader, mServiceRoot          *systray.MenuItem
	mConnect, mOpenProfile, mInvite                            *systray.MenuItem
	mLanguageRoot, mLangEnglish, mLangRussian, mGuide          *systray.MenuItem
	mHistory                                                   []*systray.MenuItem
	mStages                                                    map[string]*systray.MenuItem
	mRecheck, mPause, mCopy                                    *systray.MenuItem
	mRecent                                                    []*systray.MenuItem
	mPeersRoot                                                 *systray.MenuItem
	mPeers                                                     []*systray.MenuItem
	mSvcStar, mSvcStop, mSvcLogs, mQuit                        *systray.MenuItem
	mSvcState                                                  *systray.MenuItem
	mSvcInstall, mSvcUninstall, mAssistants, mAssistantConnect *systray.MenuItem
}

func main() {
	if nativeVersionRequested(os.Args[1:]) {
		if err := writeNativeVersion(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	options, err := parseTrayArguments(os.Args[1:])
	setLocale(options.locale)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	preferencesPath := defaultPreferencesPath()
	if options.localeExplicit && options.mode != "--check-profile" {
		if err := saveLocalePreference(preferencesPath, options.locale); err != nil {
			fmt.Fprintln(os.Stderr, tr("language.saveFailed", err))
			os.Exit(1)
		}
	}
	if options.mode == "--launch" {
		pid, err := launchDetached(options.locale)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": "murmur.tray-launch/1", "pid": pid})
		return
	}
	if options.mode == "--check-profile" {
		ctx, cancel := context.WithTimeout(context.Background(), cliTimeout)
		defer cancel()
		s, err := fetchStatus(ctx)
		if err == nil {
			err = validatePinnedStatus(s, "")
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if options.localeExplicit {
			if err := saveLocalePreference(preferencesPath, options.locale); err != nil {
				fmt.Fprintln(os.Stderr, tr("language.saveFailed", err))
				os.Exit(1)
			}
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": "murmur.tray-probe/1", "agentId": s.AgentID, "status": s})
		return
	}

	// --dump-icons кладёт пять состояний значка файлами: иконки собираются кодом, и это
	// единственный способ посмотреть на них в ревью, не заводя бинарников в репозитории.
	// --stamp-now ставит свежую дату в файл статуса. Живёт ровно столько же, сколько
	// файловый источник: образец с датой из будущего отключил бы проверку свежести.
	if options.mode == "--stamp-now" {
		if err := stampNow(options.target); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if options.mode == "--dump-icons" {
		if err := dumpIcons(options.target); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	instance, err := claimTray(trayInstanceKey(exe))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if instance == nil {
		// Murmur is already running from this bundle; its menu was asked to open.
		return
	}
	guideSignal, err := newLauncherGuideSignal(options.launcherStart)
	if err != nil {
		fmt.Fprintln(os.Stderr, tr("guide.failed"))
		os.Exit(1)
	}
	a := &app{mStages: map[string]*systray.MenuItem{}, pinnedAgent: os.Getenv("MURMUR_EXPECTED_AGENT"), preferencesPath: preferencesPath, actionResult: "action.none", guideSignal: guideSignal, instance: instance}
	systray.Run(a.onReady, func() {})
}

func (a *app) setupMenu() {
	systray.SetIcon(iconBytes(colGrey, false))
	systray.SetTitle("Murmur")
	systray.SetTooltip(tr("menu.initialTooltip"))

	a.mHeader = systray.AddMenuItem(tr("menu.initialStatus"), "")
	a.mHeader.Disable()
	// Shown only while no profile exists: the first thing a new user can do from the tray.
	a.mConnect = systray.AddMenuItem(tr("menu.connect"), tr("menu.connectTooltip"))
	a.mConnect.Hide()
	a.mOpenProfile = systray.AddMenuItem(tr("menu.openProfile"), tr("menu.openProfileTooltip"))
	a.mOpenProfile.Hide()
	// Invite a colleague is always visible (PRD R2, letter 103).
	a.mInvite = systray.AddMenuItem(tr("menu.invite"), tr("menu.inviteTooltip"))
	// Строки истории: то, что не поместилось в цвет. Их создаём заранее — добавить
	// пункт меню после запуска systray нельзя, а гасить и показывать можно.
	for i := 0; i < historyLines; i++ {
		item := systray.AddMenuItem("", "")
		item.Disable()
		item.Hide()
		a.mHistory = append(a.mHistory, item)
	}
	systray.AddSeparator()

	a.mDoctorRoot = systray.AddMenuItem(tr("menu.doctor"), tr("menu.doctorTooltip"))
	for _, st := range doctorStages {
		item := a.mDoctorRoot.AddSubMenuItem(tr(st.messageKey)+" — "+tr("doctor.notChecked"), "")
		item.Disable()
		a.mStages[st.id] = item
	}
	a.mRecheck = a.mDoctorRoot.AddSubMenuItem(tr("menu.checkNow"), tr("menu.checkNowTooltip"))
	a.mPeersRoot = systray.AddMenuItem(tr("peer.connections"), tr("peer.wakeSeparate"))
	for i := 0; i <= peerMenuLimit; i++ {
		item := a.mPeersRoot.AddSubMenuItem("", "")
		item.Disable()
		item.Hide()
		a.mPeers = append(a.mPeers, item)
	}
	systray.AddSeparator()

	a.mPause = systray.AddMenuItem(tr("menu.pause"), tr("menu.pauseTooltip"))
	a.mWakeStatus = systray.AddMenuItem(tr("menu.wakeUnknown"), "")
	a.mWakeStatus.Disable()
	a.mActionStatus = systray.AddMenuItem(tr("action.none"), "")
	a.mActionStatus.Disable()
	// Вместо кнопки «Открыть inbox» — строки последних отправителей. Открыть переписку
	// человеку сейчас нечем, а кнопка, ведущая не туда, куда обещает именем, хуже
	// отсутствующей.
	a.mRecentHeader = systray.AddMenuItem(tr("menu.recent"), "")
	a.mRecentHeader.Disable()
	for i := 0; i < recentLines; i++ {
		item := systray.AddMenuItem("", "")
		item.Disable()
		item.Hide()
		a.mRecent = append(a.mRecent, item)
	}
	a.mCopy = systray.AddMenuItem(tr("menu.copy"), tr("menu.copyTooltip"))
	a.mServiceRoot = systray.AddMenuItem(tr("menu.service"), "")
	a.mSvcState = a.mServiceRoot.AddSubMenuItem(tr("menu.serviceUnmanaged"), tr("menu.serviceUnmanagedTooltip"))
	a.mSvcState.Disable()
	a.mSvcState.Hide()
	a.mSvcStar = a.mServiceRoot.AddSubMenuItem(tr("menu.start"), "")
	a.mSvcStop = a.mServiceRoot.AddSubMenuItem(tr("menu.stop"), "")
	a.mSvcInstall = a.mServiceRoot.AddSubMenuItem(tr("menu.install"), tr("menu.serviceElevationTooltip"))
	a.mSvcUninstall = a.mServiceRoot.AddSubMenuItem(tr("menu.uninstall"), tr("menu.serviceElevationTooltip"))
	a.mSvcLogs = a.mServiceRoot.AddSubMenuItem(tr("menu.serviceLogs"), tr("menu.serviceLogsTooltip"))
	a.mAssistants = systray.AddMenuItem(tr("menu.assistants"), "")
	a.mAssistantConnect = a.mAssistants.AddSubMenuItem(tr("menu.assistantConnect"), "")
	systray.AddSeparator()
	a.setupUpdates()
	systray.AddSeparator()
	a.mLanguageRoot = systray.AddMenuItem(tr("language.root"), tr("language.tooltip"))
	a.mLangEnglish = a.mLanguageRoot.AddSubMenuItem(tr("language.english"), "")
	a.mLangRussian = a.mLanguageRoot.AddSubMenuItem(tr("language.russian"), "")
	a.mGuide = systray.AddMenuItem(tr("guide.menu"), tr("guide.tooltip"))
	a.mQuit = systray.AddMenuItem(tr("menu.quit"), tr("menu.quitTooltip"))
	a.renderLanguageSelection()
}

func (a *app) onReady() {
	a.setupMenu()
	if needsFirstRun() {
		go a.showFirstRun()
	}
	go a.pollLoop()
	go a.refreshDoctor()
	go a.handleClicks()
	go a.updateLoop()
	go func() {
		for a.instance.wait() {
			if needsFirstRun() {
				go a.showFirstRun()
			} else {
				_ = openOwnMenu()
			}
		}
	}()
	if a.guideSignal != nil {
		go func() {
			if a.guideSignal.wait() && !needsFirstRun() && !guideSeenPreference(a.preferencesPath) {
				a.showGuide()
			}
		}()
	}
}

func (a *app) refreshStatus() {
	ctx, cancel := context.WithTimeout(context.Background(), cliTimeout)
	s, err := fetchStatus(ctx)
	cancel()
	a.mu.Lock()
	if err == nil {
		err = validatePinnedStatus(s, a.pinnedAgent)
	}
	if err != nil {
		s = nil
	} else if a.pinnedAgent == "" {
		a.pinnedAgent = s.AgentID
	}
	a.status, a.statusErr = s, err
	a.mu.Unlock()
	a.render(resolve(s, err))
}
func (a *app) pollLoop() {
	for {
		a.refreshStatus()
		time.Sleep(statusInterval)
	}
}

func (a *app) render(v Verdict) {
	base := colGrey
	switch v.Level {
	case LevelRed:
		base = colRed
	case LevelYellow:
		base = colYellow
	case LevelGreen:
		base = colGreen
	}
	a.mu.Lock()
	available := !a.updateBusy && a.updateErr == nil && a.updates.page(time.Now()) != ""
	a.mu.Unlock()
	systray.SetIcon(iconBytes(base, v.Unread, available))
	a.renderUpdateState()

	a.mu.Lock()
	n := 0
	if a.status != nil && a.status.Wake.Delivery.PendingUndelivered != nil {
		n = *a.status.Wake.Delivery.PendingUndelivered
	}
	a.mu.Unlock()
	systray.SetTooltip(statusTooltip(v, n, available))
	a.mHeader.SetTitle(v.Reason)
	if v.Code == "profile.not-configured" {
		a.mConnect.Show()
		a.mOpenProfile.Show()
	} else {
		a.mConnect.Hide()
		a.mOpenProfile.Hide()
	}

	a.renderRecent()
	a.renderPeers()

	for i, item := range a.mHistory {
		if i < len(v.History) {
			item.SetTitle(v.History[i])
			item.Show()
			continue
		}
		item.Hide()
	}

	a.mu.Lock()
	paused := a.status != nil && a.status.Wake.Config.Enabled != nil && !*a.status.Wake.Config.Enabled
	_, bindingErr := selectedCLI()
	ready := bindingErr == nil && a.status != nil && !a.actionBusy && a.pinnedAgent != ""
	serviceReady, serviceState, serviceTip := serviceControls(a.status, ready, serviceAdmin())
	wakeKnown := a.status != nil && a.status.Wake.Config.Enabled != nil
	wakeText := tr("menu.wakeUnknown")
	if a.status != nil {
		wakeText = tr("menu.wakeState", boolText(a.status.Wake.Config.Enabled), boolText(a.status.Wake.Effective.Enabled), boolText(a.status.Wake.Effective.NeedsRestart))
	}
	a.mu.Unlock()
	a.mWakeStatus.SetTitle(wakeText)
	if ready && wakeKnown {
		a.mPause.Enable()
	} else {
		a.mPause.Disable()
	}
	// Without an elevated token a click asks Windows for consent (UAC) instead of sending the
	// user to an administrator terminal.
	if serviceReady {
		a.mSvcStar.Enable()
		a.mSvcStop.Enable()
	} else {
		a.mSvcStar.Disable()
		a.mSvcStop.Disable()
	}
	a.mSvcStar.SetTitle(tr("menu.start"))
	a.mSvcStop.SetTitle(tr("menu.stop"))
	if serviceState != "" {
		a.mSvcState.SetTitle(serviceState)
		a.mSvcState.SetTooltip(serviceTip)
		a.mSvcState.Show()
	} else {
		a.mSvcState.Hide()
	}
	a.mSvcStar.SetTooltip(serviceTip)
	a.mSvcStop.SetTooltip(serviceTip)
	if paused {
		a.mPause.SetTitle(tr("menu.resume"))
	} else {
		a.mPause.SetTitle(tr("menu.pause"))
	}
}

func (a *app) refreshDoctor() {
	ctx, cancel := context.WithTimeout(context.Background(), doctorTimeout)
	fresh, err := fetchStatus(ctx)
	a.mu.Lock()
	expected := a.pinnedAgent
	if err == nil {
		err = validatePinnedStatus(fresh, expected)
	}
	if err == nil && a.pinnedAgent == "" {
		a.pinnedAgent = fresh.AgentID
	}
	a.mu.Unlock()
	var d *Doctor
	if err == nil {
		d, err = fetchDoctor(ctx)
	}
	if err == nil && (d.AgentID != fresh.AgentID) {
		err = fmt.Errorf("%s", tr("doctor.identityMismatch"))
	}
	cancel()

	a.mu.Lock()
	if err != nil {
		d = nil
	}
	a.doctor, a.doctorErr = d, err
	a.mu.Unlock()

	for _, st := range doctorStages {
		item := a.mStages[st.id]
		if err != nil {
			item.SetTitle(tr(st.messageKey) + " — " + tr("doctor.unavailable"))
			continue
		}
		item.SetTitle(tr(st.messageKey) + " — " + stageLabel(d, st.id))
	}
}

func (a *app) handleClicks() {
	for {
		select {
		case <-a.mRecheck.ClickedCh:
			go a.refreshDoctor()
		case <-a.mPause.ClickedCh:
			go a.runCLI("wake", "toggle")
		case <-a.mCopy.ClickedCh:
			go a.copyDiagnostics()
		case <-a.mSvcStar.ClickedCh:
			go a.runCLI("service", "start")
		case <-a.mSvcStop.ClickedCh:
			go a.runCLI("service", "stop")
		case <-a.mSvcInstall.ClickedCh:
			go a.runCLI("service", "install")
		case <-a.mSvcUninstall.ClickedCh:
			go a.runCLI("service", "uninstall")
		case <-a.mSvcLogs.ClickedCh:
			go a.openLogs()
		case <-a.mAssistantConnect.ClickedCh:
			go a.connectSelectedAssistants()
		case <-a.mUpdateCheck.ClickedCh:
			a.requestUpdates(nil)
		case <-a.mUpdatePage.ClickedCh:
			a.openUpdatePage()
		case <-a.mUpdateEnable.ClickedCh:
			a.requestUpdatePreference(true)
		case <-a.mUpdateDisable.ClickedCh:
			a.requestUpdatePreference(false)
		case <-a.mLangEnglish.ClickedCh:
			a.changeLocale(localeEnglish)
		case <-a.mLangRussian.ClickedCh:
			a.changeLocale(localeRussian)
		case <-a.mGuide.ClickedCh:
			go a.showGuide()
		case <-a.mConnect.ClickedCh:
			go a.connectToColleague()
		case <-a.mInvite.ClickedCh:
			go a.inviteColleague()
		case <-a.mOpenProfile.ClickedCh:
			go a.openExistingProfile()
		case <-a.mQuit.ClickedCh:
			if confirmTrayExit() {
				systray.Quit()
				return
			}
		}
	}
}

func boolText(v *bool) string {
	if v == nil {
		return tr("bool.unknown")
	}
	if *v {
		return tr("bool.yes")
	}
	return tr("bool.no")
}
func (a *app) runCLI(args ...string) {
	a.mu.Lock()
	if a.actionBusy {
		a.mu.Unlock()
		return
	}
	a.actionBusy = true
	expected := a.pinnedAgent
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.actionBusy = false; a.mu.Unlock(); a.refreshStatus() }()
	ctx, cancel := context.WithTimeout(context.Background(), mutationTimeout)
	defer cancel()
	fresh, err := fetchStatus(ctx)
	if err == nil {
		err = validatePinnedStatus(fresh, expected)
	}
	if err == nil && args[0] == "wake" {
		if fresh.Wake.Config.Enabled == nil {
			err = fmt.Errorf("%s", tr("wake.settingUnknown"))
		} else if *fresh.Wake.Config.Enabled {
			args[1] = "pause"
		} else {
			args[1] = "resume"
		}
	}
	if err == nil && args[0] == "service" {
		if allowed, _, hint := serviceControls(fresh, true, serviceAdmin()); !allowed {
			err = fmt.Errorf("%s", hint)
		}
	}
	if err == nil && args[0] == "service" && args[1] == "uninstall" && !askYesNo(tr("menu.service"), tr("menu.uninstallConfirm")) {
		return
	}
	if err == nil && args[0] == "service" && !serviceAdmin() {
		// The elevated CLI cannot hand its reply back; it exits 0 only after confirming the
		// requested service state, and the deferred refresh re-reads the status.
		var b cliBinding
		if b, err = selectedCLI(); err == nil {
			err = runElevated(ctx, b.Node, b.arguments(append(args, "--json")), filepath.Dir(b.Entry))
		}
		switch {
		case errors.Is(err, errElevationCancelled):
			err = fmt.Errorf("%s", tr("action.elevationCancelled"))
		case errors.Is(err, errElevatedTimeout):
			err = fmt.Errorf("%s", tr("action.elevatedTimeout"))
		}
	} else if err == nil {
		var out []byte
		out, err = runRaw(ctx, append(args, "--json")...)
		if err == nil {
			err = validateAction(out, args[0], args[1])
		}
	}
	if err != nil {
		a.mu.Lock()
		a.actionResult = "action.failed"
		a.actionErr = err
		a.mu.Unlock()
		a.mActionStatus.SetTitle(tr("action.failed"))
		a.mActionStatus.SetTooltip(tr("action.failedTooltip"))
		if args[0] == "service" {
			tell(tr("menu.service"), serviceActionMessage(err))
		}
	} else {
		a.mu.Lock()
		a.actionResult = "action.success"
		a.actionErr = nil
		a.mu.Unlock()
		a.mActionStatus.SetTitle(tr("action.success"))
		a.mActionStatus.SetTooltip("")
	}
}

func (a *app) copyDiagnostics() {
	a.mu.Lock()
	payload := map[string]any{
		"collectedAt": time.Now().UTC().Format(time.RFC3339),
		"status":      a.status,
		"statusError": errText(a.statusErr),
		"doctor":      a.doctor,
		"doctorError": errText(a.doctorErr),
		"actionError": errText(a.actionErr),
	}
	a.mu.Unlock()

	buf, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	if err := toClipboard(buf); err != nil {
		systray.SetTooltip(tr("clipboard.failed", err))
		return
	}
	systray.SetTooltip(tr("clipboard.copied"))
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func stampNow(path string) error {
	buf, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var raw map[string]any
	if err := json.Unmarshal(buf, &raw); err != nil {
		return err
	}
	raw["generatedAt"] = time.Now().UTC().Format(time.RFC3339)
	out, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}

// renderRecent показывает, от кого пришли последние сообщения и когда. Это ответ на
// вопрос «что произошло», который цвет дать не может.
func (a *app) renderRecent() {
	a.mu.Lock()
	lines := recentLinesForStatus(a.status)
	a.mu.Unlock()

	for i, item := range a.mRecent {
		if i < len(lines) {
			item.SetTitle(lines[i])
			item.Show()
			continue
		}
		item.Hide()
	}
}

func (a *app) renderLanguageSelection() {
	a.mLangEnglish.Uncheck()
	a.mLangRussian.Uncheck()
	if currentLocale() == localeRussian {
		a.mLangRussian.Check()
	} else {
		a.mLangEnglish.Check()
	}
}

func (a *app) renderPeers() {
	a.mu.Lock()
	lines := peerLinesForStatus(a.status)
	a.mu.Unlock()
	for i, item := range a.mPeers {
		if i < len(lines) {
			item.SetTitle(lines[i])
			item.Show()
		} else {
			item.Hide()
		}
	}
}

func (a *app) changeLocale(locale string) {
	if !validLocale(locale) {
		return
	}
	if err := saveLocalePreference(a.preferencesPath, locale); err != nil {
		systray.SetTooltip(tr("language.saveFailed", err))
		return
	}
	if locale == currentLocale() {
		return
	}
	setLocale(locale)
	a.applyLocale()
	go a.refreshStatus()
	go a.refreshDoctor()
}

func (a *app) applyLocale() {
	a.mPeersRoot.SetTitle(tr("peer.connections"))
	a.mPeersRoot.SetTooltip(tr("peer.wakeSeparate"))
	a.mDoctorRoot.SetTitle(tr("menu.doctor"))
	a.mDoctorRoot.SetTooltip(tr("menu.doctorTooltip"))
	a.mRecheck.SetTitle(tr("menu.checkNow"))
	a.mRecheck.SetTooltip(tr("menu.checkNowTooltip"))
	a.mPause.SetTooltip(tr("menu.pauseTooltip"))
	a.mRecentHeader.SetTitle(tr("menu.recent"))
	a.mCopy.SetTitle(tr("menu.copy"))
	a.mCopy.SetTooltip(tr("menu.copyTooltip"))
	a.mServiceRoot.SetTitle(tr("menu.service"))
	a.mSvcLogs.SetTitle(tr("menu.serviceLogs"))
	a.mSvcLogs.SetTooltip(tr("menu.serviceLogsTooltip"))
	a.mSvcInstall.SetTitle(tr("menu.install"))
	a.mSvcUninstall.SetTitle(tr("menu.uninstall"))
	a.mSvcInstall.SetTooltip(tr("menu.serviceElevationTooltip"))
	a.mSvcUninstall.SetTooltip(tr("menu.serviceElevationTooltip"))
	a.mAssistants.SetTitle(tr("menu.assistants"))
	a.mAssistantConnect.SetTitle(tr("menu.assistantConnect"))
	a.mUpdatesRoot.SetTitle(tr("updates.root"))
	a.mUpdatesRoot.SetTooltip(tr("updates.rootTooltip"))
	a.mUpdateCheck.SetTooltip(tr("updates.checkNowTooltip"))
	a.mUpdatePage.SetTitle(tr("updates.open"))
	a.mUpdatePage.SetTooltip(tr("updates.openTooltip"))
	a.mUpdateEnable.SetTitle(tr("updates.enable"))
	a.mUpdateDisable.SetTitle(tr("updates.disable"))
	a.mUpdatePrivacy.SetTitle(tr("updates.privacy"))
	a.mUpdatePrivacy.SetTooltip(tr("updates.privacyTooltip"))
	a.mLanguageRoot.SetTitle(tr("language.root"))
	a.mLanguageRoot.SetTooltip(tr("language.tooltip"))
	a.mLangEnglish.SetTitle(tr("language.english"))
	a.mLangRussian.SetTitle(tr("language.russian"))
	a.mGuide.SetTitle(tr("guide.menu"))
	a.mGuide.SetTooltip(tr("guide.tooltip"))
	a.mInvite.SetTitle(tr("menu.invite"))
	a.mInvite.SetTooltip(tr("menu.inviteTooltip"))
	a.mQuit.SetTitle(tr("menu.quit"))
	a.mQuit.SetTooltip(tr("menu.quitTooltip"))
	a.renderLanguageSelection()

	a.mu.Lock()
	s, statusErr, actionResult := a.status, a.statusErr, a.actionResult
	d, doctorErr := a.doctor, a.doctorErr
	a.mu.Unlock()
	a.mActionStatus.SetTitle(tr(actionResult))
	a.render(resolve(s, statusErr))
	for _, stage := range doctorStages {
		label := tr("doctor.notChecked")
		if doctorErr != nil {
			label = tr("doctor.unavailable")
		} else if d != nil {
			label = stageLabel(d, stage.id)
		}
		a.mStages[stage.id].SetTitle(tr(stage.messageKey) + " — " + label)
	}
}

func (a *app) showGuide() {
	dismissed, err := showNativeGuide()
	if err != nil {
		systray.SetTooltip(tr("guide.failed"))
		return
	}
	if dismissed {
		if err := saveGuideSeenPreference(a.preferencesPath); err != nil {
			systray.SetTooltip(tr("guide.saveFailed"))
		}
	}
}

// connectToColleague sets Murmur up from an invitation file without a terminal: the default
// profile %LOCALAPPDATA%Murmur, a name from the Windows user, the reply saved where the user
// chooses, one UAC prompt for the service, and the detected AI clients connected.
func (a *app) connectToColleague() {
	a.mu.Lock()
	if a.actionBusy {
		a.mu.Unlock()
		return
	}
	a.actionBusy = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.actionBusy = false; a.mu.Unlock(); a.refreshStatus() }()
	local := os.Getenv("LOCALAPPDATA")
	profile := filepath.Join(local, "Murmur")
	b, err := setupBinding(profile)
	if err == nil && !filepath.IsAbs(local) {
		err = errors.New("LOCALAPPDATA")
	}
	if err != nil {
		tell(tr("onboarding.title"), tr("onboarding.noRuntime", err))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	steps := onboardingSteps{
		chooseClients:            showAssistantChoices,
		confirmClientReplacement: showAssistantReplacement,
		pickInvitation:           func() (string, bool) { return fileDialog(false, tr("onboarding.pickInvite"), "") },
		pickReply:                func(suggested string) (string, bool) { return fileDialog(true, tr("onboarding.pickReply"), suggested) },
		confirm:                  askYesNo,
		inform:                   tell,
		revealFile:               revealAndCopy,
		exists:                   fileExists,
		cli:                      func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, args...) },
		elevated: func(args ...string) error {
			if serviceAdmin() {
				_, err := runSetupCLI(ctx, b, args...)
				return err
			}
			err := runElevated(ctx, b.Node, append([]string{b.Entry}, args...), filepath.Dir(b.Entry))
			if errors.Is(err, errElevationCancelled) {
				return fmt.Errorf("%s", tr("action.elevationCancelled"))
			}
			return err
		},
	}
	replyDir := desktopFolder()
	if replyDir == "" {
		replyDir = os.Getenv("USERPROFILE")
	}
	r, err := runOnboarding(steps, profile, defaultAgentID(os.Getenv("USERNAME")), replyDir)
	if errors.Is(err, errOnboardingCancelled) {
		return
	}
	if err != nil {
		tell(tr("onboarding.title"), err.Error())
		return
	}
	message := tr("onboarding.done", r.AgentID)
	if len(r.Clients) > 0 {
		message += "\n\n" + tr("assistants.connected", strings.Join(r.Clients, ", "))
	} else {
		message += "\n\n" + tr("assistants.noneConnected")
	}
	tell(tr("onboarding.title"), message)
}

// openExistingProfile is for people who already made a profile with the CLI: pick its folder,
// and the tray uses it from now on.
func (a *app) openExistingProfile() {
	dir, ok := folderDialog(tr("menu.openProfile"))
	if !ok {
		return
	}
	if err := chooseTrayProfile(dir); err != nil {
		tell(tr("menu.openProfile"), err.Error())
		return
	}
	a.mu.Lock()
	a.pinnedAgent = "" // a different profile is a different identity
	a.mu.Unlock()
	a.refreshStatus()
}

func (a *app) showFirstRun() {
	err := runFirstRun(firstRunActions{withSetupNode(a.connectToColleague), withSetupNode(a.inviteColleague), withSetupNode(a.openExistingProfile)}, a.changeLocale)
	if err != nil {
		tell("Murmur", tr("guide.failed"))
	}
}
