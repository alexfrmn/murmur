package main

// Разбор ответа с проверками, которых обычный разбор в структуру не даёт.
//
// Зачем. В Go отсутствующий ключ и ключ со значением null дают один и тот же пустой
// указатель, поэтому «движок забыл поле» и «движок измерял и не смог» слились бы в один
// ответ. Для человека разница существенная: в первом случае чинить надо движок или
// несовпадение версий, во втором — само измерение. Смешать их значит спрятать вторую
// поломку под видом первой.

import (
	"encoding/json"
	"fmt"
	"strings"
)

// statusError несёт код причины: значок обязан назвать его тем же закрытым списком,
// что и остальные вердикты.
type statusError struct {
	code string
	msg  string
}

func (e *statusError) Error() string { return e.msg }

// requiredKeys — ключи, без которых цвет не выводится, и тип, который они обязаны
// иметь. Значение может быть null (движок мерил и не смог), сам ключ обязан быть.
//
// Лишние незнакомые ключи пропускаются молча и запрещать их нельзя: контракт
// аддитивный, движок вправе добавить поле в пределах мажорной версии. На этом же
// держится формат образцов — служебные ключи с долларом и есть незнакомые поля.
var requiredKeys = []struct{ path, kind string }{
	{"schema", "string"},
	{"generatedAt", "string"},
	{"service.state", "string"},
	{"broker.state", "string"},
	{"peers.list", "array"},
	{"inbox.unread", "number"},
	{"outbox.queue.failed", "number"},
	{"outbox.queue.dlq", "number"},
	{"wake.config.enabled", "bool"},
	{"wake.faults.lastFault", "string"},
	{"wake.delivery.pendingUndelivered", "number"},
}

// kindOf возвращает имя типа значения. null проходит любой тип: это законный ответ
// «мерил и не смог», и отличается он от отсутствия ключа, а не от типа.
func kindOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "bool"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// counterPaths — счётчики, для которых отрицательное значение означает сломанный ответ.
// Минус один в очереди это не «меньше нуля сообщений».
var counterPaths = []string{
	"inbox.unread",
	"inbox.total",
	"outbox.queue.pending",
	"outbox.queue.inflight",
	"outbox.queue.delivered",
	"outbox.queue.failed",
	"outbox.queue.dlq",
	"wake.delivery.pendingUndelivered",
	"service.restartsLastHour",
}

func lookup(doc map[string]any, path string) (any, bool) {
	cur := any(doc)
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		v, ok := m[part]
		if !ok {
			return nil, false
		}
		cur = v
	}
	return cur, true
}

func parseStatus(buf []byte) (*Status, error) {
	var doc map[string]any
	if err := json.Unmarshal(buf, &doc); err != nil {
		return nil, &statusError{"schema.unparsable", "ответ не разобран: " + err.Error()}
	}

	var absent, wrong []string
	for _, k := range requiredKeys {
		v, ok := lookup(doc, k.path)
		if !ok {
			absent = append(absent, k.path)
			continue
		}
		if got := kindOf(v); got != "null" && got != k.kind {
			wrong = append(wrong, fmt.Sprintf("%s: %s вместо %s", k.path, got, k.kind))
		}
	}
	if len(absent) > 0 {
		return nil, &statusError{"schema.missing-key",
			"в ответе нет обязательных ключей: " + strings.Join(absent, ", ")}
	}
	if len(wrong) > 0 {
		return nil, &statusError{"schema.wrong-type",
			"тип значения не тот: " + strings.Join(wrong, ", ")}
	}

	for _, k := range counterPaths {
		v, ok := lookup(doc, k)
		if !ok {
			continue
		}
		if n, isNum := v.(float64); isNum && n < 0 {
			return nil, &statusError{"schema.invalid-value",
				fmt.Sprintf("счётчик %s отрицательный (%v): ответ сломан", k, v)}
		}
	}

	var s Status
	if err := json.Unmarshal(buf, &s); err != nil {
		return nil, &statusError{"schema.unparsable", "ответ не разобран: " + err.Error()}
	}
	return &s, nil
}

// validateDoctor проверяет то самое правило, ради которого doctor сделан поэтапным:
// отказ останавливает цепочку, дальше идут пропуски со ссылкой на остановивший этап.
// Образец, который правило нарушает, обязан быть отвергнут, а не показан как эталон.
func validateDoctor(d *Doctor) error {
	failedAt := ""
	for _, st := range d.Stages {
		if failedAt != "" {
			if st.State != "skip" {
				return fmt.Errorf("этап %s идёт после отказа %s в состоянии %q: отказ обязан останавливать цепочку",
					st.ID, failedAt, st.State)
			}
			want := "blocked-by:" + failedAt
			if st.Reason != want {
				return fmt.Errorf("этап %s пропущен с причиной %q вместо %q", st.ID, st.Reason, want)
			}
			continue
		}
		if st.State == "fail" {
			failedAt = st.ID
		}
	}
	return nil
}
