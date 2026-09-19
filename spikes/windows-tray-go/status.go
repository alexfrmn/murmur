package main

// Единственный источник данных значка — murmur status --json и murmur doctor --json.
// Схема описана в CONTRACT.md; здесь она же в виде структур и правило цвета, которое
// выводится из полей без догадок на стороне UI.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	statusSchema = "murmur.status/1"
	doctorSchema = "murmur.doctor/1"
	// Снимок старше этого возраста считается несостоятельным: значок, рисующий
	// вчерашнее зелёное, неотличим от значка, который врёт.
	maxStatusAge = 2 * time.Minute
)

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
	Service     struct {
		State        string `json:"state"` // running | stopped | failed | unknown
		Manager      string `json:"manager"`
		Since        string `json:"since"`
		PID          int    `json:"pid"`
		LastExitCode *int   `json:"lastExitCode"`
	} `json:"service"`
	Broker struct {
		URL         string `json:"url"`
		State       string `json:"state"` // connected | disconnected | unauthorized | unknown
		ConnectedAt string `json:"connectedAt"`
		LastError   string `json:"lastError"`
	} `json:"broker"`
	Peers []Peer `json:"peers"`
	Inbox struct {
		Unread int    `json:"unread"`
		Total  int    `json:"total"`
		LastAt string `json:"lastAt"`
	} `json:"inbox"`
	Outbox struct {
		Pending         int    `json:"pending"`
		Inflight        int    `json:"inflight"`
		Delivered       int    `json:"delivered"`
		Failed          int    `json:"failed"`
		DLQ             int    `json:"dlq"`
		OldestPendingAt string `json:"oldestPendingAt"`
	} `json:"outbox"`
	Deliveries []Delivery `json:"deliveries"`
	Wake       struct {
		Enabled            bool   `json:"enabled"`
		Mode               string `json:"mode"`
		Responder          string `json:"responder"`
		LastDeliveredAt    string `json:"lastDeliveredAt"`
		LastFault          string `json:"lastFault"`
		PendingUndelivered int    `json:"pendingUndelivered"`
	} `json:"wake"`
}

type DoctorStage struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	State      string `json:"state"` // ok | warn | fail | skip
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
}

// resolve выводит цвет из полей схемы. Каждая ветка названа полем, из которого следует,
// — требование JARVIS: не хватает поля под цвет, это дефект схемы, а не место для догадки.
//
// Порядок: серый → красный → жёлтый → зелёный. Серый выигрывает у красного сознательно:
// при остановленной службе всё остальное в снимке — прошлое, и показывать прошлое как
// настоящее значит врать тем же способом, каким врёт /health, всегда отвечающий двести.
func resolve(s *Status, err error) Verdict {
	if err != nil {
		return Verdict{LevelGrey, false, "статус недоступен: " + err.Error()}
	}
	if !schemaKnown(s.Schema, statusSchema) {
		return Verdict{LevelGrey, false, "схема ответа незнакома: " + s.Schema}
	}
	unread := s.Inbox.Unread > 0
	if age, ok := ageOf(s.GeneratedAt); ok && age > maxStatusAge {
		return Verdict{LevelGrey, unread, fmt.Sprintf("снимок устарел на %s", age.Round(time.Second))}
	}

	switch s.Service.State {
	case "stopped":
		return Verdict{LevelGrey, unread, "служба остановлена"}
	case "unknown", "":
		return Verdict{LevelGrey, unread, "состояние службы неизвестно"}
	case "failed":
		return Verdict{LevelRed, unread, "служба в состоянии failed"}
	}
	if s.Outbox.DLQ > 0 || s.Outbox.Failed > 0 {
		return Verdict{LevelRed, unread, fmt.Sprintf("недоставленные: failed %d, DLQ %d", s.Outbox.Failed, s.Outbox.DLQ)}
	}
	if s.Wake.LastFault != "" {
		return Verdict{LevelRed, unread, "wake не сработал: " + s.Wake.LastFault}
	}
	if s.Wake.PendingUndelivered > 0 {
		return Verdict{LevelRed, unread, fmt.Sprintf("wake не доставил %d сообщений", s.Wake.PendingUndelivered)}
	}

	switch s.Broker.State {
	case "unauthorized":
		return Verdict{LevelYellow, unread, "брокер отверг токен"}
	case "connected":
	default:
		reason := "брокер недоступен"
		if s.Broker.LastError != "" {
			reason += ": " + s.Broker.LastError
		}
		return Verdict{LevelYellow, unread, reason}
	}
	if unpaired := unpairedPeers(s.Peers); len(unpaired) > 0 {
		return Verdict{LevelYellow, unread, "пиры без пары: " + strings.Join(unpaired, ", ")}
	}

	return Verdict{LevelGreen, unread, fmt.Sprintf("демон, брокер и %d пира в порядке", len(s.Peers))}
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

// schemaKnown сравнивает мажорную версию. Движок и значок обновляются врозь, поэтому
// незнакомая версия обязана гаснуть в серый, а не рисоваться наугад.
func schemaKnown(got, want string) bool {
	return got == want
}

func ageOf(ts string) (time.Duration, bool) {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0, false
	}
	return time.Since(t), true
}

func runJSON(ctx context.Context, out any, args ...string) error {
	bin := os.Getenv("MURMUR_BIN")
	if bin == "" {
		bin = "murmur"
	}
	buf, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
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
	if cliErr == nil {
		return &d, nil
	}
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
	if !schemaKnown(d.Schema, doctorSchema) {
		return nil, errors.New("схема doctor незнакома: " + d.Schema)
	}
	return &d, nil
}
