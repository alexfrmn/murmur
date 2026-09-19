package main

// Единственный источник данных значка — murmur status --json и murmur doctor --json.
// Схема описана в CONTRACT.md; здесь она же структурами и правило цвета, выведенное из
// полей без догадок на стороне UI.
//
// Правило схемы, которому подчинены все типы ниже: неизвестное значение приходит как
// null, никогда как ноль и никогда как пустой список. Поэтому счётчики и флаги здесь
// указатели: ноль означает измеренный ноль, nil означает «не смог посмотреть».

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
	// неизвестный возраст, как и непарсимая дата.
	clockSkewTolerance = 5 * time.Second
)

type Peer struct {
	AgentID string `json:"agentId"`
	// Paired — null, когда парность неизвестна: наличие локальных ключей само по себе
	// не доказывает, что пара установлена с обеих сторон, а человек читает из слова
	// «спарен» именно это.
	Paired        *bool  `json:"paired"`
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
		State            string  `json:"state"`
		Manager          string  `json:"manager"`
		Since            *string `json:"since"`
		PID              int     `json:"pid"`
		LastExitCode     *int    `json:"lastExitCode"`
		LastFailureAt    *string `json:"lastFailureAt"`
		RestartsLastHour *int    `json:"restartsLastHour"`
	} `json:"service"`

	Broker struct {
		URL         string  `json:"url"`
		State       string  `json:"state"`
		ConnectedAt *string `json:"connectedAt"`
		LastError   *string `json:"lastError"`
		LastErrorAt *string `json:"lastErrorAt"`
	} `json:"broker"`

	Peers struct {
		// List — nil, когда список получить не удалось; пустой непустой срез означает
		// «пиров действительно нет». encoding/json различает null и [] сам.
		List          []Peer  `json:"list"`
		UnknownReason *string `json:"unknownReason"`
	} `json:"peers"`

	Inbox struct {
		Unread        *int    `json:"unread"`
		Total         *int    `json:"total"`
		LastAt        *string `json:"lastAt"`
		UnknownReason *string `json:"unknownReason"`
	} `json:"inbox"`

	// Секции разделены по источникам: признак неизвестности обязан стоять там, где
	// делается измерение. Очередь читается из базы, журнал отказов — из лога; если
	// база ответила, а лог прочитать не удалось, «вся секция неизвестна» было бы
	// неправдой, и в серое ушло бы то, что на самом деле измерено.
	Outbox struct {
		Queue struct {
			Pending         *int    `json:"pending"`
			Inflight        *int    `json:"inflight"`
			Delivered       *int    `json:"delivered"`
			Failed          *int    `json:"failed"`
			DLQ             *int    `json:"dlq"`
			OldestPendingAt *string `json:"oldestPendingAt"`
			UnknownReason   *string `json:"unknownReason"`
		} `json:"queue"`
		Faults struct {
			LastError     *string `json:"lastError"`
			LastErrorAt   *string `json:"lastErrorAt"`
			UnknownReason *string `json:"unknownReason"`
		} `json:"faults"`
	} `json:"outbox"`

	Deliveries []Delivery `json:"deliveries"`

	Wake struct {
		Config struct {
			Enabled       *bool   `json:"enabled"`
			Mode          string  `json:"mode"`
			Responder     string  `json:"responder"`
			UnknownReason *string `json:"unknownReason"`
		} `json:"config"`
		// Effective — наблюдаемое поведение, Config — записанное в настройках. Они
		// расходятся, пока изменение не применено: «поставлено на паузу» без свежего
		// наблюдения было бы обещанием вместо факта.
		Effective struct {
			Enabled       *bool   `json:"enabled"`
			NeedsRestart  *bool   `json:"needsRestart"`
			ObservedAt    *string `json:"observedAt"`
			UnknownReason *string `json:"unknownReason"`
		} `json:"effective"`
		Delivery struct {
			PendingUndelivered *int    `json:"pendingUndelivered"`
			LastDeliveredAt    *string `json:"lastDeliveredAt"`
			UnknownReason      *string `json:"unknownReason"`
		} `json:"delivery"`
		Faults struct {
			LastFault     *string `json:"lastFault"`
			LastFaultAt   *string `json:"lastFaultAt"`
			UnknownReason *string `json:"unknownReason"`
		} `json:"faults"`
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
	Level Level
	// Code — устойчивый код причины. Именно он сверяется между реализациями: текст
	// формулировок на разных платформах разойдётся неизбежно, и сравнивать его
	// бессмысленно.
	Code   string
	Unread bool
	Reason string
	// History — то, что не поместилось в цвет и обязано остаться текстом в меню.
	// Без этого честное «не знаю» серого превращается в сокрытие: человек видит серый
	// и решает, что отказов не было вовсе.
	History []string
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// resolve выводит цвет из полей схемы. Каждая ветка названа полем, из которого следует.
//
// Порядок: серый по состоянию наблюдателя → известный красный → известный жёлтый →
// серый по незнанию → зелёный. Известный отказ кричит и тогда, когда часть полей
// измерить не удалось; неизмеренное поле не даёт объявить зелёное и не затыкает уже
// известное.
func resolve(s *Status, err error) Verdict {
	if err != nil {
		return Verdict{Level: LevelGrey, Code: "status.unavailable", Reason: "статус недоступен: " + err.Error()}
	}
	if !schemaKnown(s.Schema, statusSchema) {
		return Verdict{Level: LevelGrey, Code: "schema.unknown", Reason: "схема ответа незнакома: " + s.Schema}
	}

	unread := s.Inbox.Unread != nil && *s.Inbox.Unread > 0
	hist := history(s)
	out := func(l Level, code, reason string) Verdict {
		return Verdict{Level: l, Code: code, Unread: unread, Reason: reason, History: hist}
	}

	// Возраст, который не удалось определить, — такой же повод для серого, как возраст
	// сверх порога. Пропустить проверку значит поверить снимку неизвестной давности.
	age, ok := ageOf(s.GeneratedAt)
	switch {
	case !ok:
		return out(LevelGrey, "snapshot.unparsable", "дата снимка не разобрана: "+s.GeneratedAt)
	case age > maxStatusAge:
		return out(LevelGrey, "snapshot.stale", fmt.Sprintf("снимок устарел на %s", age.Round(time.Second)))
	case age < -clockSkewTolerance:
		return out(LevelGrey, "snapshot.future", fmt.Sprintf("снимок из будущего на %s, часы разъехались", (-age).Round(time.Second)))
	}

	switch s.Service.State {
	case "stopped":
		return out(LevelGrey, "service.stopped", "служба остановлена")
	case "unknown", "":
		return out(LevelGrey, "service.unknown", "состояние службы неизвестно")
	case "failed":
		return out(LevelRed, "service.failed", "служба в состоянии failed")
	}

	// missing копит поля, без которых цвет не выводится. Разница между нулём и
	// неизмеренным — это разница между «в очереди пусто» и «я не смог посмотреть в
	// очередь»: первое успокаивает справедливо, второе ложно.
	var missing []string
	need := func(name string, p *int) (int, bool) {
		if p == nil {
			missing = append(missing, name)
			return 0, false
		}
		return *p, true
	}

	failed, okFailed := need("outbox.queue.failed", s.Outbox.Queue.Failed)
	dlq, okDLQ := need("outbox.queue.dlq", s.Outbox.Queue.DLQ)
	if (okFailed && failed > 0) || (okDLQ && dlq > 0) {
		return out(LevelRed, "outbox.undelivered", fmt.Sprintf("недоставленные: failed %s, DLQ %s", num(s.Outbox.Queue.Failed), num(s.Outbox.Queue.DLQ)))
	}
	if fault := str(s.Wake.Faults.LastFault); fault != "" {
		return out(LevelRed, "wake.fault", "wake не сработал: "+fault)
	}
	if pending, okPending := need("wake.delivery.pendingUndelivered", s.Wake.Delivery.PendingUndelivered); okPending && pending > 0 {
		return out(LevelRed, "wake.pending", "wake не доставил "+plural(pending, "сообщение", "сообщения", "сообщений"))
	}
	// Журнал отказов — отдельный источник от очереди: null в поле последней ошибки
	// означает «отказа не было», и отличить его от «не смотрел» можно только признаком
	// на том подмножестве, которое читается этим источником.
	for _, sec := range []struct{ name, reason string }{
		{"журнал отказов отправки", str(s.Outbox.Faults.UnknownReason)},
		{"журнал отказов пробуждения", str(s.Wake.Faults.UnknownReason)},
		{"очередь", str(s.Outbox.Queue.UnknownReason)},
		{"доставка wake", str(s.Wake.Delivery.UnknownReason)},
		{"настройки wake", str(s.Wake.Config.UnknownReason)},
		{"действующее состояние wake", str(s.Wake.Effective.UnknownReason)},
	} {
		if sec.reason != "" {
			missing = append(missing, sec.name+" ("+sec.reason+")")
		}
	}

	switch s.Broker.State {
	case "unauthorized":
		return out(LevelYellow, "broker.unauthorized", "брокер отверг токен")
	case "connected":
	case "", "unknown":
		missing = append(missing, "broker.state")
	default:
		reason := "брокер недоступен"
		if e := str(s.Broker.LastError); e != "" {
			reason += ": " + e
		}
		return out(LevelYellow, "broker.unreachable", reason)
	}

	if s.Peers.List == nil {
		label := "peers.list"
		if r := str(s.Peers.UnknownReason); r != "" {
			label += " (" + r + ")"
		}
		missing = append(missing, label)
	} else {
		if len(s.Peers.List) == 0 {
			// Ноль пиров — это «ещё не настроено», а не «всё хорошо»: новому участнику
			// писать некому, и зелёный значок сказал бы ему прямую неправду.
			return out(LevelYellow, "peers.none", "пиров нет, обмен ещё не настроен")
		}
		var unpaired, unknownPair []string
		for _, p := range s.Peers.List {
			switch {
			case p.Paired == nil:
				unknownPair = append(unknownPair, p.AgentID)
			case !*p.Paired:
				unpaired = append(unpaired, p.AgentID)
			}
		}
		if len(unpaired) > 0 {
			return out(LevelYellow, "peers.unpaired", "пиры без пары: "+strings.Join(unpaired, ", "))
		}
		if len(unknownPair) > 0 {
			missing = append(missing, "парность неизвестна: "+strings.Join(unknownPair, ", "))
		}
	}

	if s.Inbox.Unread == nil {
		label := "inbox.unread"
		if r := str(s.Inbox.UnknownReason); r != "" {
			label += " (" + r + ")"
		}
		missing = append(missing, label)
	}

	if len(missing) > 0 {
		return out(LevelGrey, "unmeasured", "не измерено: "+strings.Join(missing, ", "))
	}
	return out(LevelGreen, "ok", "демон, брокер и "+plural(len(s.Peers.List), "пир", "пира", "пиров")+" в порядке")
}

// num печатает число либо «не измерено»: подставлять ноль вместо неизвестного значит
// успокаивать ложно.
func num(p *int) string {
	if p == nil {
		return "не измерено"
	}
	return strconv.Itoa(*p)
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
	add("последняя ошибка отправки", str(s.Outbox.Faults.LastError), str(s.Outbox.Faults.LastErrorAt))
	add("последний сбой пробуждения", str(s.Wake.Faults.LastFault), str(s.Wake.Faults.LastFaultAt))
	add("последняя ошибка брокера", str(s.Broker.LastError), str(s.Broker.LastErrorAt))
	if at := str(s.Service.LastFailureAt); at != "" {
		add("служба падала", "", at)
	}
	// Расхождение записанного и действующего — то, о чём человек обязан узнать сам:
	// он нажал паузу, она принята настройками и не работает.
	if c, e := s.Wake.Config.Enabled, s.Wake.Effective.Enabled; c != nil && e != nil && *c != *e {
		line := "пауза задана в настройках и не применена"
		if *c {
			line = "пробуждение включено в настройках и не действует"
		}
		if r := s.Wake.Effective.NeedsRestart; r != nil && *r {
			line += ", нужен перезапуск службы"
		}
		out = append(out, line)
	}
	if n := s.Service.RestartsLastHour; n != nil && *n > 0 {
		out = append(out, "подъёмов демона за час: "+strconv.Itoa(*n))
	}
	return out
}

// schemaKnown сравнивает имя и мажорную версию: движок вправе добавить поле, не гася
// значок. Мажор меняется только при несовместимом изменении формы.
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
	// Проверка версии стоит после обоих путей: у status эту роль играет правило цвета,
	// у doctor её не играет никто другой.
	if !schemaKnown(d.Schema, doctorSchema) {
		return nil, errors.New("схема doctor незнакома: " + d.Schema)
	}
	return &d, nil
}

// firstLine живёт здесь, а не в коде значка: её зовёт runJSON, а main.go собирается
// только под Windows — тесты на другой ОС иначе не собрались бы.
func firstLine(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, 10); i >= 0 {
		s = s[:i]
	}
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}
