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
	"regexp"
	"sort"
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
	Code string
	// Missing — поля, которых не хватило для вывода цвета: только пути в точечной
	// записи, единым форматом. Сравниваются между реализациями как множество, поэтому
	// человеческого текста и причин здесь нет — иначе контракт оказался бы завязан на
	// язык интерфейса одной из реализаций, а смена формулировки красила бы сборку.
	Missing []string
	// MissingWhy — путь поля к устойчивому коду причины. Текст для человека каждая
	// реализация строит из кода сама.
	MissingWhy map[string]string
	Unread     bool
	Reason     string
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
	// Independent startup work (such as a cached update check) can render before
	// the first status arrives. No observation is unknown, never healthy.
	if s == nil && err == nil {
		return Verdict{Level: LevelGrey, Code: "status.unavailable", Reason: tr("status.notCollected")}
	}
	if err != nil {
		code := "status.unavailable"
		var se *statusError
		if errors.As(err, &se) {
			code = se.code
		}
		return Verdict{Level: LevelGrey, Code: code, Reason: tr("status.unavailable", err)}
	}
	if !schemaKnown(s.Schema, statusSchema) {
		return Verdict{Level: LevelGrey, Code: "schema.unknown", Reason: tr("status.schema", s.Schema)}
	}

	unread := s.Inbox.Unread != nil && *s.Inbox.Unread > 0
	hist := history(s)
	var missing []string
	why := map[string]string{}
	// note помечает поле недостающим: путь отдельно, причина кодом отдельно.
	note := func(path, code string) {
		missing = append(missing, path)
		why[path] = code
	}
	out := func(l Level, code, reason string) Verdict {
		sort.Strings(missing)
		return Verdict{Level: l, Code: code, Missing: missing, MissingWhy: why, Unread: unread, Reason: reason, History: hist}
	}

	// Возраст, который не удалось определить, — такой же повод для серого, как возраст
	// сверх порога. Пропустить проверку значит поверить снимку неизвестной давности.
	age, ok := ageOf(s.GeneratedAt)
	switch {
	case !ok:
		return out(LevelGrey, "snapshot.unparsable", tr("status.unparsableDate", s.GeneratedAt))
	case age > maxStatusAge:
		return out(LevelGrey, "snapshot.stale", tr("status.stale", age.Round(time.Second)))
	case age < -clockSkewTolerance:
		return out(LevelGrey, "snapshot.future", tr("status.future", (-age).Round(time.Second)))
	}

	switch s.Service.State {
	case "stopped":
		return out(LevelGrey, "service.stopped", tr("status.serviceStopped"))
	case "unknown", "":
		return out(LevelGrey, "service.unknown", tr("status.serviceUnknown"))
	case "failed":
		return out(LevelRed, "service.failed", tr("status.serviceFailed"))
	}

	// missing копит поля, без которых цвет не выводится. Разница между нулём и
	// неизмеренным — это разница между «в очереди пусто» и «я не смог посмотреть в
	// очередь»: первое успокаивает справедливо, второе ложно.
	need := func(path string, p *int) (int, bool) {
		if p == nil {
			note(path, "unmeasured")
			return 0, false
		}
		return *p, true
	}

	failed, okFailed := need("outbox.queue.failed", s.Outbox.Queue.Failed)
	dlq, okDLQ := need("outbox.queue.dlq", s.Outbox.Queue.DLQ)
	if (okFailed && failed > 0) || (okDLQ && dlq > 0) {
		return out(LevelRed, "outbox.undelivered", tr("status.undelivered", num(s.Outbox.Queue.Failed), num(s.Outbox.Queue.DLQ)))
	}
	if fault := str(s.Wake.Faults.LastFault); fault != "" {
		return out(LevelRed, "wake.fault", tr("status.wakeFault", fault))
	}
	if pending, okPending := need("wake.delivery.pendingUndelivered", s.Wake.Delivery.PendingUndelivered); okPending && pending > 0 {
		return out(LevelRed, "wake.pending", tr("status.pendingWake", messageCount(pending)))
	}
	// Журнал отказов — отдельный источник от очереди: null в поле последней ошибки
	// означает «отказа не было», и отличить его от «не смотрел» можно только признаком
	// на том подмножестве, которое читается этим источником.
	// Секция, которую не удалось прочитать целиком, отмечается путём самой секции.
	// Человеческая причина от движка живёт в ответе и в сравнение не идёт.
	for _, sec := range []struct{ path, reason string }{
		{"outbox.faults", str(s.Outbox.Faults.UnknownReason)},
		{"wake.faults", str(s.Wake.Faults.UnknownReason)},
		{"outbox.queue", str(s.Outbox.Queue.UnknownReason)},
		{"wake.delivery", str(s.Wake.Delivery.UnknownReason)},
		{"wake.config", str(s.Wake.Config.UnknownReason)},
		{"wake.effective", str(s.Wake.Effective.UnknownReason)},
	} {
		if sec.reason != "" {
			note(sec.path, "source-unreadable")
		}
	}

	switch s.Broker.State {
	case "unauthorized":
		return out(LevelYellow, "broker.unauthorized", tr("status.brokerUnauthorized"))
	case "connected":
	case "", "unknown":
		missing = append(missing, "broker.state")
	default:
		reason := tr("status.brokerUnavailable")
		if e := str(s.Broker.LastError); e != "" {
			reason += ": " + e
		}
		return out(LevelYellow, "broker.unreachable", reason)
	}

	if s.Peers.List == nil {
		code := "unmeasured"
		if str(s.Peers.UnknownReason) != "" {
			code = "source-unreadable"
		}
		note("peers.list", code)
	} else {
		if len(s.Peers.List) == 0 {
			// Ноль пиров — это «ещё не настроено», а не «всё хорошо»: новому участнику
			// писать некому, и зелёный значок сказал бы ему прямую неправду.
			return out(LevelYellow, "peers.none", tr("status.noPeers"))
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
			return out(LevelYellow, "peers.unpaired", tr("status.unpaired", strings.Join(unpaired, ", ")))
		}
		for _, id := range unknownPair {
			note("peers.list."+id+".paired", "unmeasured")
		}
	}

	if s.Inbox.Unread == nil {
		code := "unmeasured"
		if str(s.Inbox.UnknownReason) != "" {
			code = "source-unreadable"
		}
		note("inbox.unread", code)
	}

	// Система работает в режиме, которого ей не задавали. Человек нажал паузу, она
	// принята настройками и не действует; зелёный сказал бы ему «всё хорошо» ровно в тот
	// момент, когда его действие не применилось. Цвет отвечает за состояние целиком, а
	// не только за доставку: «пиров нет» жёлтый по той же причине — обмен исправен,
	// система не в том состоянии, которое человек считает установленным.
	if c, e := s.Wake.Config.Enabled, s.Wake.Effective.Enabled; c != nil && e != nil && *c != *e {
		reason := tr("status.modePause")
		if *c {
			reason = tr("status.modeWake")
		}
		if r := s.Wake.Effective.NeedsRestart; r != nil && *r {
			reason += tr("status.modeRestart")
		}
		return out(LevelYellow, "wake.mode-mismatch", reason)
	}

	if len(missing) > 0 {
		return out(LevelGrey, "unmeasured", tr("status.unmeasured", strings.Join(missing, ", ")))
	}
	return out(LevelGreen, "ok", tr("status.healthy", peerCount(len(s.Peers.List))))
}

// num печатает число либо «не измерено»: подставлять ноль вместо неизвестного значит
// успокаивать ложно.
func num(p *int) string {
	if p == nil {
		return tr("status.numberUnknown")
	}
	return strconv.Itoa(*p)
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
			line += tr("history.happened")
		}
		if at != "" {
			line += ", " + at
		}
		out = append(out, line)
	}
	add(tr("history.send"), str(s.Outbox.Faults.LastError), str(s.Outbox.Faults.LastErrorAt))
	add(tr("history.wake"), str(s.Wake.Faults.LastFault), str(s.Wake.Faults.LastFaultAt))
	add(tr("history.broker"), str(s.Broker.LastError), str(s.Broker.LastErrorAt))
	if at := str(s.Service.LastFailureAt); at != "" {
		add(tr("history.service"), "", at)
	}
	// Расхождение записанного и действующего — то, о чём человек обязан узнать сам:
	// он нажал паузу, она принята настройками и не работает.
	if c, e := s.Wake.Config.Enabled, s.Wake.Effective.Enabled; c != nil && e != nil && *c != *e {
		line := tr("status.modePause")
		if *c {
			line = tr("status.modeWake")
		}
		if r := s.Wake.Effective.NeedsRestart; r != nil && *r {
			line += tr("status.modeRestart")
		}
		// Первой строкой: действие человека не применилось, и это важнее прошлых отказов.
		out = append([]string{line}, out...)
	}
	if n := s.Service.RestartsLastHour; n != nil && *n > 0 {
		out = append(out, tr("history.daemonRestart", *n))
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
	parts := regexp.MustCompile(`^([^/]+)/([1-9][0-9]*)(?:\.[0-9]+)?$`).FindStringSubmatch(s)
	if parts == nil {
		return "", 0, false
	}
	value, err := strconv.Atoi(parts[2])
	return parts[1], value, err == nil
}

func ageOf(ts string) (time.Duration, bool) {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0, false
	}
	return time.Since(t), true
}

// Both JSON and raw calls use the same bounded, explicit runtime binding.
func runRaw(ctx context.Context, args ...string) ([]byte, error) { return invokeCLI(ctx, args...) }
func runJSON(ctx context.Context, out any, args ...string) error {
	buf, err := runRaw(ctx, args...)
	if err != nil {
		return err
	}
	return json.Unmarshal(buf, out)
}

// Debug snapshots are permitted only without a bound profile; they never mask a
// failure of the selected live CLI or authorize profile mutations.
func fetchStatus(ctx context.Context) (*Status, error) {
	buf, cliErr := runRaw(ctx, "status", "--json")
	if cliErr != nil {
		path := os.Getenv("MURMUR_STATUS_FILE")
		if path == "" || os.Getenv("MURMUR_PROFILE") != "" {
			return nil, cliErr
		}
		var err error
		if buf, err = os.ReadFile(path); err != nil {
			return nil, fmt.Errorf("%s", tr("status.fileFallback", cliErr, err))
		}
	}
	return parseStatus(buf)
}

func fetchDoctor(ctx context.Context) (*Doctor, error) {
	var d Doctor
	cliErr := runJSON(ctx, &d, "doctor", "--json")
	if cliErr != nil {
		path := os.Getenv("MURMUR_DOCTOR_FILE")
		if path == "" || os.Getenv("MURMUR_PROFILE") != "" {
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
	age, validTime := ageOf(d.GeneratedAt)
	if !validTime || age > maxStatusAge || age < -clockSkewTolerance {
		return nil, errors.New(tr("doctor.stale"))
	}
	if !schemaKnown(d.Schema, doctorSchema) {
		return nil, errors.New(tr("doctor.schema", d.Schema))
	}
	// Ответ, нарушающий собственное правило цепочки, показывать нельзя: человек прочтёт
	// этапы после отказа как измеренные.
	if err := validateDoctor(&d); err != nil {
		return nil, errors.New(tr("doctor.chain", err))
	}
	return &d, nil
}
