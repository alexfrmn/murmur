package main

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
)

type inboxMessage struct {
	Sender, CreatedAt, Text string
	AssistantRead, Unread   *bool
}
type inboxSnapshot struct {
	Schema, AgentID string
	Unread          *int
	Messages        []inboxMessage
}

// Plain native text only. Preserve Unicode characters and bound by runes, not
// UTF-8 bytes; remove controls and direction overrides from untrusted messages.
func plainPreview(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return value
}

func parseInbox(data []byte, identity string) (*inboxSnapshot, error) {
	var v inboxSnapshot
	var raw struct{ Messages []map[string]json.RawMessage }
	invalid := errors.New("inbox.response-invalid")
	if json.Unmarshal(data, &v) != nil || json.Unmarshal(data, &raw) != nil || v.Schema != "murmur.inbox/1" || identity == "" || v.AgentID != identity || v.Messages == nil || len(v.Messages) > 20 || (v.Unread != nil && *v.Unread < 0) {
		return nil, invalid
	}
	for i, m := range v.Messages {
		if m.Sender == "" {
			return nil, invalid
		}
		if _, err := time.Parse(time.RFC3339Nano, m.CreatedAt); err != nil {
			return nil, invalid
		}
		for _, key := range []string{"sender", "createdAt", "text", "assistantRead", "unread"} {
			if _, ok := raw.Messages[i][key]; !ok {
				return nil, invalid
			}
		}
		for _, key := range []string{"sender", "createdAt", "text"} {
			var value any
			if json.Unmarshal(raw.Messages[i][key], &value) != nil {
				return nil, invalid
			}
			if _, ok := value.(string); !ok {
				return nil, invalid
			}
		}
	}
	return &v, nil
}

func messageColumns(m inboxMessage) [4]string {
	at, _ := time.Parse(time.RFC3339Nano, m.CreatedAt)
	read := tr("messages.unmeasured")
	if m.AssistantRead != nil {
		if *m.AssistantRead {
			read = tr("bool.yes")
		} else {
			read = tr("bool.no")
		}
	}
	return [4]string{plainPreview(m.Sender, 80), at.Local().Format("02.01.2006 15:04"), read, plainPreview(m.Text, 120)}
}

// A read never marks anything. Explicit mark-read is bound to a fresh Identity,
// validates the write acknowledgement, then reads again; Assistant state is never
// inferred from this user's separate read cursor.
func readMessages(cli func(...string) ([]byte, error), expected string, mark bool) (*inboxSnapshot, error) {
	out, err := cli("status", "--json")
	if err != nil {
		return nil, err
	}
	s, err := parseStatus(out)
	if err == nil {
		err = validatePinnedStatus(s, expected)
	}
	if err != nil {
		return nil, err
	}
	if mark {
		if expected == "" {
			return nil, errors.New("inbox.identity-unconfirmed")
		}
		out, err = cli("inbox", "mark-read", "--json")
		if err != nil {
			return nil, err
		}
		var ack struct {
			Schema, AgentID string
			RowID           *int64
		}
		if json.Unmarshal(out, &ack) != nil || ack.Schema != "murmur.read/1" || ack.AgentID != expected || ack.RowID == nil || *ack.RowID < 0 {
			return nil, errors.New("inbox.mark-unconfirmed")
		}
	}
	out, err = cli("inbox", "read", "--limit", "20", "--json")
	if err != nil {
		return nil, err
	}
	return parseInbox(out, s.AgentID)
}
