//go:build windows

package main

// Значок Murmur для Windows. Окон нет, Electron нет: состояние видно цветом, детали —
// в меню. Данные берутся только из murmur status --json и murmur doctor --json.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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
var doctorStages = []struct{ id, title string }{
	{"config", "конфиг валиден"},
	{"daemon", "демон жив и на этом store"},
	{"broker", "брокер отвечает, токен принят"},
	{"peers", "пиры спарены"},
	{"roundtrip", "тестовое сообщение вернулось"},
	{"wake", "wake-режим и кто отвечает"},
}

type app struct {
	mu            sync.Mutex
	status        *Status
	statusErr     error
	pinnedAgent   string
	actionBusy    bool
	mActionStatus *systray.MenuItem
	mWakeStatus   *systray.MenuItem
	doctor        *Doctor
	doctorErr     error

	mHeader  *systray.MenuItem
	mHistory []*systray.MenuItem
	mStages  map[string]*systray.MenuItem
	mRecheck *systray.MenuItem
	mPause   *systray.MenuItem
	mRecent  []*systray.MenuItem
	mCopy    *systray.MenuItem
	mSvcStar *systray.MenuItem
	mSvcStop *systray.MenuItem
	mSvcLogs *systray.MenuItem
	mQuit    *systray.MenuItem
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--launch" {
		pid, err := launchDetached()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": "murmur.tray-launch/1", "pid": pid})
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--check-profile" {
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
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": "murmur.tray-probe/1", "agentId": s.AgentID, "status": s})
		return
	}

	// --dump-icons кладёт пять состояний значка файлами: иконки собираются кодом, и это
	// единственный способ посмотреть на них в ревью, не заводя бинарников в репозитории.
	// --stamp-now ставит свежую дату в файл статуса. Живёт ровно столько же, сколько
	// файловый источник: образец с датой из будущего отключил бы проверку свежести.
	if len(os.Args) == 3 && os.Args[1] == "--stamp-now" {
		if err := stampNow(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "--dump-icons" {
		if err := dumpIcons(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	a := &app{mStages: map[string]*systray.MenuItem{}, pinnedAgent: os.Getenv("MURMUR_EXPECTED_AGENT")}
	systray.Run(a.onReady, func() {})
}

func (a *app) onReady() {
	systray.SetIcon(iconBytes(colGrey, false))
	systray.SetTitle("Murmur")
	systray.SetTooltip("Murmur: статус ещё не снят")

	a.mHeader = systray.AddMenuItem("статус не снят", "")
	a.mHeader.Disable()
	// Строки истории: то, что не поместилось в цвет. Их создаём заранее — добавить
	// пункт меню после запуска systray нельзя, а гасить и показывать можно.
	for i := 0; i < historyLines; i++ {
		item := systray.AddMenuItem("", "")
		item.Disable()
		item.Hide()
		a.mHistory = append(a.mHistory, item)
	}
	systray.AddSeparator()

	doctorRoot := systray.AddMenuItem("Проверка (doctor)", "этапы последней проверки")
	for _, st := range doctorStages {
		item := doctorRoot.AddSubMenuItem(st.title+" — не проверялось", "")
		item.Disable()
		a.mStages[st.id] = item
	}
	a.mRecheck = doctorRoot.AddSubMenuItem("Проверить сейчас", "doctor без peer: тестовое сообщение не отправляется")
	systray.AddSeparator()

	a.mPause = systray.AddMenuItem("Пауза", "меняет настройку wake; без автоматического перезапуска")
	a.mWakeStatus = systray.AddMenuItem("Wake: не измерено", "")
	a.mWakeStatus.Disable()
	a.mActionStatus = systray.AddMenuItem("Действие ещё не выполнялось", "")
	a.mActionStatus.Disable()
	// Вместо кнопки «Открыть inbox» — строки последних отправителей. Открыть переписку
	// человеку сейчас нечем, а кнопка, ведущая не туда, куда обещает именем, хуже
	// отсутствующей.
	recentHeader := systray.AddMenuItem("Последние входящие", "")
	recentHeader.Disable()
	for i := 0; i < recentLines; i++ {
		item := systray.AddMenuItem("", "")
		item.Disable()
		item.Hide()
		a.mRecent = append(a.mRecent, item)
	}
	a.mCopy = systray.AddMenuItem("Скопировать диагностику", "status и doctor в буфер обмена")
	svc := systray.AddMenuItem("Служба", "")
	a.mSvcStar = svc.AddSubMenuItem("Старт", "")
	a.mSvcStop = svc.AddSubMenuItem("Стоп", "")
	a.mSvcLogs = svc.AddSubMenuItem("Каталог журналов недоступен в CLI", "Windows logs path пока не подтверждает native-каталог")
	a.mSvcLogs.Disable()
	systray.AddSeparator()
	a.mQuit = systray.AddMenuItem("Выход", "закрыть значок; служба продолжит работать")

	go a.pollLoop()
	go a.refreshDoctor()
	go a.handleClicks()
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
	systray.SetIcon(iconBytes(base, v.Unread))

	tip := "Murmur — " + v.Reason
	if v.Unread {
		a.mu.Lock()
		n := 0
		if a.status != nil && a.status.Inbox.Unread != nil {
			n = *a.status.Inbox.Unread
		}
		a.mu.Unlock()
		tip += fmt.Sprintf("; непрочитанных: %d", n)
	}
	// Подсказка в трее обрезается системой на 127 символах — режем сами, иначе
	// Windows молча покажет обрубок без многоточия.
	if len([]rune(tip)) > 120 {
		tip = string([]rune(tip)[:117]) + "..."
	}
	systray.SetTooltip(tip)
	a.mu.Lock()
	agentID := a.pinnedAgent
	a.mu.Unlock()
	a.mHeader.SetTitle(agentID + ": " + v.Reason)

	a.renderRecent()

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
	wakeKnown := a.status != nil && a.status.Wake.Config.Enabled != nil
	wakeText := "Wake: не измерено"
	if a.status != nil {
		wakeText = fmt.Sprintf("Wake: настроено %s; действует %s; перезапуск %s", boolText(a.status.Wake.Config.Enabled), boolText(a.status.Wake.Effective.Enabled), boolText(a.status.Wake.Effective.NeedsRestart))
	}
	a.mu.Unlock()
	a.mWakeStatus.SetTitle(wakeText)
	if ready && wakeKnown {
		a.mPause.Enable()
	} else {
		a.mPause.Disable()
	}
	if ready && serviceAdmin() {
		a.mSvcStar.Enable()
		a.mSvcStop.Enable()
	} else {
		a.mSvcStar.Disable()
		a.mSvcStop.Disable()
	}
	if !serviceAdmin() {
		a.mSvcStar.SetTitle("Старт: нужна повышенная CLI-консоль")
		a.mSvcStop.SetTitle("Стоп: нужна повышенная CLI-консоль")
	}
	if paused {
		a.mPause.SetTitle("Возобновить")
	} else {
		a.mPause.SetTitle("Пауза")
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
		err = fmt.Errorf("Личность doctor не совпадает с профилем")
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
			item.SetTitle(st.title + " — проверка недоступна")
			continue
		}
		item.SetTitle(st.title + " — " + stageLabel(d, st.id))
	}
}

// stageLabel: этап, которого в ответе нет, называется отсутствующим. Пустая строка
// читалась бы как «ок», а это ровно та ложь, ради которой doctor и делается поэтапным.
func stageLabel(d *Doctor, id string) string {
	for _, s := range d.Stages {
		if s.ID != id {
			continue
		}
		label := map[string]string{"ok": "ок", "warn": "предупреждение", "fail": "отказ", "skip": "пропущен"}[s.State]
		if label == "" {
			label = s.State
		}
		if s.ElapsedMs > 0 {
			label = fmt.Sprintf("%s, %d мс", label, s.ElapsedMs)
		}
		if s.State != "ok" && s.Detail != "" {
			label += ": " + s.Detail
		}
		return label
	}
	return "нет в ответе"
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
		case <-a.mQuit.ClickedCh:
			systray.Quit()
			return
		}
	}
}

func boolText(v *bool) string {
	if v == nil {
		return "неизвестно"
	}
	if *v {
		return "да"
	}
	return "нет"
}
func (a *app) runCLI(args ...string) {
	a.mu.Lock()
	if a.actionBusy || a.pinnedAgent == "" {
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
			err = fmt.Errorf("Настройка wake не подтверждена")
		} else if *fresh.Wake.Config.Enabled {
			args[1] = "pause"
		} else {
			args[1] = "resume"
		}
	}
	if err == nil {
		var out []byte
		out, err = runRaw(ctx, append(args, "--json")...)
		if err == nil {
			err = validateAction(out, args[0], args[1])
		}
	}
	if err != nil {
		a.mActionStatus.SetTitle("Действие не подтверждено; повтор не выполнялся")
		a.mActionStatus.SetTooltip(err.Error())
	} else {
		a.mActionStatus.SetTitle("Команда подтверждена; статус перечитывается")
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
	}
	a.mu.Unlock()

	buf, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	if err := toClipboard(buf); err != nil {
		systray.SetTooltip("буфер обмена недоступен: " + err.Error())
		return
	}
	systray.SetTooltip("диагностика скопирована в буфер обмена")
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// toClipboard кладёт текст через clip.exe. Кодировка здесь не мелочь: clip.exe читает
// stdin как UTF-16LE только при наличии BOM, иначе разбирает байты кодовой страницей
// консоли и кириллица приезжает мусором.
func toClipboard(utf8 []byte) error {
	cmd := exec.Command("cmd", "/c", "clip")
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if _, err := in.Write(utf16LEWithBOM(string(utf8))); err != nil {
		in.Close()
		return err
	}
	in.Close()
	return cmd.Wait()
}

func utf16LEWithBOM(s string) []byte {
	out := []byte{0xff, 0xfe}
	for _, r := range s {
		if r > 0xffff {
			r -= 0x10000
			hi := 0xd800 + (r >> 10)
			lo := 0xdc00 + (r & 0x3ff)
			out = append(out, byte(hi), byte(hi>>8), byte(lo), byte(lo>>8))
			continue
		}
		out = append(out, byte(r), byte(r>>8))
	}
	return out
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
	var lines []string
	if a.status != nil {
		for _, d := range a.status.Deliveries {
			if d.Direction != "inbound" {
				continue
			}
			lines = append(lines, d.Peer+" — "+d.At)
			if len(lines) == recentLines {
				break
			}
		}
		if len(lines) == 0 && a.status.Inbox.Total != nil && *a.status.Inbox.Total == 0 {
			lines = append(lines, "входящих ещё не было")
		}
	}
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
