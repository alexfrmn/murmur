//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

// This opt-in window never invokes the engine or touches reading state on disk.
func TestNativeMessagesAcceptance(t *testing.T) {
	if os.Getenv("MURMUR_MESSAGES_PROOF") != "1" {
		t.Skip("native visual acceptance only")
	}
	setLocale(os.Getenv("MURMUR_PROOF_LOCALE"))
	showMessagesWindow("fixture", func(_ context.Context, _ string, mark bool) (*inboxSnapshot, error) {
		if os.Getenv("MURMUR_PROOF_MODE") == "error" {
			return nil, errors.New("synthetic.failure")
		}
		s := &inboxSnapshot{Schema: "murmur.inbox/1", AgentID: "fixture", Messages: []inboxMessage{}}
		if os.Getenv("MURMUR_PROOF_MODE") == "empty" {
			return s, nil
		}
		yes, no := true, false
		count := 2
		if mark {
			count = 0
		}
		s.Unread = &count
		s.Messages = []inboxMessage{
			{Sender: "Anna", CreatedAt: "2026-09-24T09:00:00Z", Text: "The drawing is ready. Please check the dimensions before the review.", AssistantRead: &yes, Unread: &no},
			{Sender: "Михаил", CreatedAt: "2026-09-24T08:55:00Z", Text: "Проверка сообщения: " + strings.Repeat("длинный текст ", 15), AssistantRead: &no, Unread: &yes},
			{Sender: "Colleague & team", CreatedAt: "2026-09-24T08:50:00Z", Text: "<b>Plain text</b> — no markup is rendered.", AssistantRead: nil, Unread: nil},
		}
		if mark {
			for i := range s.Messages {
				s.Messages[i].Unread = &no
			}
		}
		return s, nil
	})
}
