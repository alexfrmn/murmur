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
var doctorStages = []struct{ id, title string }{
	{"config", "конфиг валиден"},
	{"daemon", "демон жив и на этом store"},
	{"broker", "брокер отвечает, токен принят"},
	{"peers", "пиры спарены"},
	{"roundtrip", "тестовое сообщение вернулось"},
	{"wake", "wake-режим и кто отвечает"},
}

type app struct {
	mu        sync.Mutex
	status    *Status
	statusErr error
	doctor    *Doctor
	doctorErr error

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
	a := &app{mStages: map[string]*systray.MenuItem{}}
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
	a.mRecheck = doctorRoot.AddSubMenuItem("Проверить сейчас", "гоняет doctor, включая тестовое сообщение")
	systray.AddSeparator()

	a.mPause = systray.AddMenuItem("Пауза", "приостановить доставку wake")
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
	a.mSvcLogs = svc.AddSubMenuItem("Логи", "открыть папку с логами")
	systray.AddSeparator()
	a.mQuit = systray.AddMenuItem("Выход", "закрыть значок; служба продолжит работать")

	go a.pollLoop()
	go a.refreshDoctor()
	go a.handleClicks()
}

func (a *app) pollLoop() {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), cliTimeout)
		s, err := fetchStatus(ctx)
		cancel()

		a.mu.Lock()
		a.status, a.statusErr = s, err
		a.mu.Unlock()

		a.render(resolve(s, err))
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
	a.mHeader.SetTitle(v.Reason)

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
	paused := a.status != nil && a.status.Wake.Effective.Enabled != nil && !*a.status.Wake.Effective.Enabled
	a.mu.Unlock()
	if paused {
		a.mPause.SetTitle("Возобновить")
	} else {
		a.mPause.SetTitle("Пауза")
	}
}

func (a *app) refreshDoctor() {
	ctx, cancel := context.WithTimeout(context.Background(), doctorTimeout)
	d, err := fetchDoctor(ctx)
	cancel()

	a.mu.Lock()
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
			// Кнопка живёт, но в приёмку не идёт: drain() в wake-monitor не смотрит на
			// enabled, поэтому отложенное доезжает и на паузе.
			a.mu.Lock()
			paused := a.status != nil && a.status.Wake.Effective.Enabled != nil && !*a.status.Wake.Effective.Enabled
			a.mu.Unlock()
			verb := "pause"
			if paused {
				verb = "resume"
			}
			go a.runCLI("wake", verb)
		case <-a.mCopy.ClickedCh:
			go a.copyDiagnostics()
		case <-a.mSvcStar.ClickedCh:
			go a.runCLI("service", "start")
		case <-a.mSvcStop.ClickedCh:
			go a.runCLI("service", "stop")
		case <-a.mSvcLogs.ClickedCh:
			go openPath(logDir())
		case <-a.mQuit.ClickedCh:
			systray.Quit()
			return
		}
	}
}

func (a *app) runCLI(args ...string) {
	bin := os.Getenv("MURMUR_BIN")
	if bin == "" {
		bin = "murmur"
	}
	ctx, cancel := context.WithTimeout(context.Background(), cliTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).CombinedOutput()
	if err != nil {
		// Старт и стоп службы требуют прав администратора. Без них команда вернёт
		// отказ, и значок обязан сказать об этом, а не промолчать.
		systray.SetTooltip(fmt.Sprintf("murmur %s: %v — %s", strings.Join(args, " "), err, firstLine(out)))
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

// logDir — один каталог логов на продукт: %ProgramData%\Murmur\logs. Человек, которому
// сказали «пришли журнал», должен идти в одно место; два каталога означают, что в момент
// разбора он посмотрит не туда и сделает вывод о продукте.
func logDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "Murmur", "logs")
}

func openPath(path string) {
	_ = os.MkdirAll(path, 0o755)
	_ = exec.Command("explorer", path).Start()
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
