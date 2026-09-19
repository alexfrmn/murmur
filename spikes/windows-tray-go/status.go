package main

// Единственный источник данных значка — murmur status --json и murmur doctor --json.
// Схема описана в CONTRACT.md; здесь она же структурами и правило цвета, выведенное из
// полей без догадок на стороне UI.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	statusSchema = "murmur.status/1"
	doctorSchema = "murmur.doctor/1"
	// Снимок старше этого возраста несостоятелен: значок, рисующий вчерашнее зелёное,
	// неотличим от значка, который врёт.
	maxStatusAge = 2 * time.Minute
	// Допуск на расхождение часов. Снимок из будущего дальше допуска — такой же
	// неизвестный возраст, как и непарсимая дата: часы разъехались, и верить снимку
	// нельзя ни в одну сторону.
	clockSkewTolerance = 5 * time.Second
)

// known — признак «секцию удалось прочитать». Пустой список пиров означает «пиров нет»,
// и это не то же самое, что «не смог узнать»: секция с нулями не равна секции, которую
// не прочитали. Отдельным полем, потому что по значениям эти два случая неразличимы.
type known struct {
	Known         *bool  `json:"known"`
	UnknownReason string `json:"unknownReason"`
}

// ok: отсутствие поля known читается как «прочитано». Движок, который поле не заполняет,
// не должен из-за этого гасить значок целиком.
func (k known) ok() bool { return k.Known == nil || *k.Known }

type Peer struct {
	AgentID       string `json:"agentId"`
	Paired        bool   `json:"paired"`
	LastInboundAt string `json:"lastInboundAt"`
	LastOutbound  string `json:"lastOutboundAt"`
}

type Delivery struct {
	MsgID     string `json:"msgId"`
	Peer      string `json:"peer"`
	Direction string `json:"direction"`
	State     string `json:"state"`
	At        string `json:"at"`
	Attempts  int    `json:"attempts"`
	Error     string `json:"error"`
}

type Status struct {
	Schema      string `json:"schema"`
	GeneratedAt string `json:"generatedAt"`
	AgentID     string `json:"agentId"`

	Service struct {
		State         string `json:"state"`
		Manager       string `json:"manager"`
		Since         string `json:"since"`
		PID           int    `json:"pid"`
		LastExitCode  *int   `json:"lastExitCode"`
		LastFailureAt string `json:"lastFailureAt"`
	} `json:"service"`

	Broker struct {
		URL         string `json:"url"`
		State       string `json:"state"`
		ConnectedAt string `json:"connectedAt"`
		LastError   string `json:"lastError"`
		LastErrorAt string `json:"lastErrorAt"`
	} `json:"broker"`

	Peers struct {
		known
		List []Peer `json:"list"`
	} `json:"peers"`

	Inbox struct {
		known
		Unread int    `json:"unread"`
		Total  int    `json:"total"`
		LastAt string `json:"lastAt"`
	} `json:"inbox"`

	Outbox struct {
		known
		Pending         int    `json:"pending"`
		Inflight        int    `json:"inflight"`
		Delivered       int    `json:"delivered"`
		Failed          int    `json:"failed"`
		DLQ             int    `json:"dlq"`
		OldestPendingAt string `json:"oldestPendingAt"`
		LastError       string `json:"lastError"`
		LastErrorAt     string `json:"lastErrorAt"`
	} `json:"outbox"`

	Deliveries []Delivery `json:"deliveries"`

	Wake struct {
		known
		Enabled            bool   `json:"enabled"`
		Mode               string `json:"mode"`
		Responder          string `json:"responder"`
		LastDeliveredAt    string `json:"lastDeliveredAt"`
		LastFault          string `json:"lastFault"`
		LastFaultAt        string `json:"lastFaultAt"`
		PendingUndelivered int    `json:"pendingUndelivered"`
	} `json:"wake"`
}

type DoctorStage struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	State      string `json:"state"`
	Detail     string `json:"detail"`
	Reason     string `json:"reason"`
	FixHint    string `json:"fixHint"`
	ElapsedMs  int    `json:"elapsedMs"`
	MeasuredAt string `json:"measuredAt"`
}

type Doctor struct {
	Schema      string        `json:"schema"`
	GeneratedAt string        `json:"generatedAt"`
	AgentID     string        `json:"agentId"`
	Stages      []DoctorStage `json:"stages"`
	Summary     struct {
		Worst       string `json:"worst"`
		FailedStage string `json:"failedStage"`
	} `json:"summary"`
}

type Level int

const (
	LevelGrey Level = iota
	LevelRed
	LevelYellow
	LevelGreen
)

type Verdict struct {
	Level  Level
	Unread bool
	Reason string
	// History — то, что не поместилось в цвет и обязано остаться текстом в меню.
	// Без этого честное «не знаю» серого превращается в сокрытие: человек видит серый
	// и решает, что отказов не было вовсе.
	History []string
}

// resolve выводит цвет из полей схемы. Каждая ветка названа полем, из которого следует.
//
// Порядок: серый по состоянию наблюдателя → красный → жёлтый → серый по незнанию →
// зелёный. Известный отказ кричит и тогда, когда часть секций прочитать не удалось;
// непрочитанная секция не даёт объявить зелёное и не затыкает уже известное.
func resolve(s *Status, err error) Verdict {
	if err != nil {
		return Verdict{Level: LevelGrey, Reason: "статус недоступен: " + err.Error()}
	}
	if !schemaKnown(s.Schema, statusSchema) {
		return Verdict{Level: LevelGrey, Reason: "схема ответа незнакома: " + s.Schema}
	}

	unread := s.Inbox.ok() && s.Inbox.Unread > 0
	hist := history(s)
	out := func(l Level, reason string) Verdict {
		return Verdict{Level: l, Unread: unread, Reason: reason, History: hist}
	}

	// Возраст, который не удалось определить, — такой же повод для серого, как возраст
	// сверх порога. Пропустить проверку значит поверить снимку неизвестной давности.
	age, ok := ageOf(s.GeneratedAt)
	switch {
	case !ok:
		return out(LevelGrey, "дата снимка не разобрана: "+s.GeneratedAt)
	case age > maxStatusAge:
		return out(LevelGrey, fmt.Sprintf("снимок устарел на %s", age.Round(time.Second)))
	case age < -clockSkewTolerance:
		return out(LevelGrey, fmt.Sprintf("снимок из будущего на %s, часы разъехались", (-age).Round(time.Second)))
	}

	switch s.Service.State {
	case "stopped":
		return out(LevelGrey, "служба остановлена")
	case "unknown", "":
		return out(LevelGrey, "состояние службы неизвестно")
	case "failed":
		return out(LevelRed, "служба в состоянии failed")
	}

	if s.Outbox.ok() && (s.Outbox.DLQ > 0 || s.Outbox.Failed > 0) {
		return out(LevelRed, fmt.Sprintf("недоставленные: failed %d, DLQ %d", s.Outbox.Failed, s.Outbox.DLQ))
	}
	if s.Wake.ok() {
		if s.Wake.LastFault != "" {
			return out(LevelRed, "wake не сработал: "+s.Wake.LastFault)
		}
		if s.Wake.PendingUndelivered > 0 {
			return out(LevelRed, "wake не доставил "+plural(s.Wake.PendingUndelivered, "сообщение", "сообщения", "сообщений"))
		}
	}

	switch s.Broker.State {
	case "unauthorized":
		return out(LevelYellow, "брокер отверг токен")
	case "connected":
	default:
		reason := "брокер недоступен"
		if s.Broker.LastError != "" {
			reason += ": " + s.Broker.LastError
		}
		return out(LevelYellow, reason)
	}

	if s.Peers.ok() {
		// Ноль пиров — это «ещё не настроено», а не «всё хорошо»: новому участнику
		// писать некому, и зелёный значок сказал бы ему прямую неправду.
		if len(s.Peers.List) == 0 {
			return out(LevelYellow, "пиров нет, обмен ещё не настроен")
		}
		if unpaired := unpairedPeers(s.Peers.List); len(unpaired) > 0 {
			return out(LevelYellow, "пиры без пары: "+strings.Join(unpaired, ", "))
		}
	}

	// Ни один известный отказ не сработал. Если часть секций прочитать не удалось,
	// зелёное объявлять нечем: это «не знаю», а не «всё хорошо».
	if unknown := unknownSections(s); len(unknown) > 0 {
		return out(LevelGrey, "не удалось прочитать: "+strings.Join(unknown, ", "))
	}
	return out(LevelGreen, "демон, брокер и "+plural(len(s.Peers.List), "пир", "пира", "пиров")+" в порядке")
}

// plural — русские формы числительных. Конкатенация «0 пира» выдаёт машину там, где
// человек ждёт языка.
func plural(n int, one, few, many string) string {
	form := many
	if mod100 := n % 100; mod100 < 11 || mod100 > 14 {
		switch n % 10 {
		case 1:
			form = one
		case 2, 3, 4:
			form = few
		}
	}
	return strconv.Itoa(n) + " " + form
}

func unknownSections(s *Status) []string {
	var out []string
	for _, sec := range []struct {
		name string
		k    known
	}{
		{"пиры", s.Peers.known},
		{"входящие", s.Inbox.known},
		{"исходящие", s.Outbox.known},
		{"wake", s.Wake.known},
	} {
		if sec.k.ok() {
			continue
		}
		label := sec.name
		if sec.k.UnknownReason != "" {
			label += " (" + sec.k.UnknownReason + ")"
		}
		out = append(out, label)
	}
	return out
}

// history собирает то, чего цвет сказать не может: последние отказы с временем. В сером
// состоянии это единственное место, где человек узнаёт, что отказы вообще были.
func history(s *Status) []string {
	var out []string
	add := func(label, text, at string) {
		if text == "" && at == "" {
			return
		}
		line := label + ": "
		if text != "" {
			line += text
		} else {
			line += "был"
		}
		if at != "" {
			line += ", " + at
		}
		out = append(out, line)
	}
	if s.Outbox.ok() {
		add("последняя ошибка отправки", s.Outbox.LastError, s.Outbox.LastErrorAt)
	}
	if s.Wake.ok() {
		add("последний сбой пробуждения", s.Wake.LastFault, s.Wake.LastFaultAt)
	}
	add("последняя ошибка брокера", s.Broker.LastError, s.Broker.LastErrorAt)
	if s.Service.LastFailureAt != "" {
		add("служба падала", "", s.Service.LastFailureAt)
	}
	return out
}

func unpairedPeers(peers []Peer) []string {
	var out []string
	for _, p := range peers {
		if !p.Paired {
			out = append(out, p.AgentID)
		}
	}
	return out
}

// schemaKnown сравнивает имя и мажорную версию: движок должен иметь право добавить поле,
// не гася значок. Мажор меняется только при несовместимом изменении формы.
func schemaKnown(got, want string) bool {
	gotName, gotMajor, gotOK := splitSchema(got)
	wantName, wantMajor, wantOK := splitSchema(want)
	return gotOK && wantOK && gotName == wantName && gotMajor == wantMajor
}

func splitSchema(s string) (name string, major int, ok bool) {
	i := strings.LastIndex(s, "/")
	if i < 0 {
		return "", 0, false
	}
	name, version := s[:i], s[i+1:]
	if j := strings.Index(version, "."); j >= 0 {
		version = version[:j]
	}
	major, err := strconv.Atoi(version)
	if err != nil || name == "" {
		return "", 0, false
	}
	return name, major, true
}

func ageOf(ts string) (time.Duration, bool) {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0, false
	}
	return time.Since(t), true
}

// runJSON: при ненулевом коде движок пишет причину в stderr по контракту. Выбросить её
// значит показать человеку «exit status 1» вместо добытого объяснения.
func runJSON(ctx context.Context, out any, args ...string) error {
	bin := os.Getenv("MURMUR_BIN")
	if bin == "" {
		bin = "murmur"
	}
	buf, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			if msg := strings.TrimSpace(string(ee.Stderr)); msg != "" {
				return fmt.Errorf("%s %s: %s", bin, strings.Join(args, " "), firstLine([]byte(msg)))
			}
		}
		return err
	}
	return json.Unmarshal(buf, out)
}

// fetchStatus: сначала CLI, при его отсутствии — файл той же формы. Файловый путь живёт
// ровно до появления команды status --json и уходит вместе с этой строкой.
func fetchStatus(ctx context.Context) (*Status, error) {
	var s Status
	cliErr := runJSON(ctx, &s, "status", "--json")
	if cliErr == nil {
		return &s, nil
	}
	path := os.Getenv("MURMUR_STATUS_FILE")
	if path == "" {
		return nil, cliErr
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("murmur status --json недоступен (%v) и файл не прочитан (%w)", cliErr, err)
	}
	if err := json.Unmarshal(buf, &s); err != nil {
		return nil, fmt.Errorf("файл статуса не разобран: %w", err)
	}
	return &s, nil
}

func fetchDoctor(ctx context.Context) (*Doctor, error) {
	var d Doctor
	cliErr := runJSON(ctx, &d, "doctor", "--json")
	if cliErr != nil {
		path := os.Getenv("MURMUR_DOCTOR_FILE")
		if path == "" {
			return nil, cliErr
		}
		buf, err := os.ReadFile(path)
		if err != nil {
			return nil, cliErr
		}
		if err := json.Unmarshal(buf, &d); err != nil {
			return nil, err
		}
	}
	// Проверка версии стоит после обоих путей: у status эту роль играет resolve, у
	// doctor её не играл никто, и незнакомая версия от движка проходила целиком.
	if !schemaKnown(d.Schema, doctorSchema) {
		return nil, errors.New("схема doctor незнакома: " + d.Schema)
	}
	return &d, nil
}

// firstLine живёт здесь, а не в коде значка: её зовёт runJSON, а main.go собирается
// только под Windows — тесты на другой ОС иначе не собрались бы.
func firstLine(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}
