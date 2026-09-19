package main

// Прогон по образцам: каждый образец несёт рядом со входом ожидаемый вердикт, и
// проверка идёт против него, а не против константы в коде этого теста. Иначе две
// реализации читают один вход по-разному и обе честно проходят свои проверки.
//
// Сверяется устойчивый код причины, а не текст: формулировки на разных платформах
// разойдутся неизбежно, и сравнивать их бессмысленно.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type expectation struct {
	Level  string `json:"level"`
	Unread bool   `json:"unread"`
	Code   string `json:"code"`
}

type fixtureMeta struct {
	Stamp  string      `json:"$stamp"`
	Expect expectation `json:"$expect"`
}

var levelNames = map[Level]string{
	LevelGrey: "grey", LevelRed: "red", LevelYellow: "yellow", LevelGreen: "green",
}

// applyStamp реализует политику даты снимка. Без неё образцы протухают, а с константой
// из будущего проверка свежести молча выключается — так и было в первой версии.
func applyStamp(s *Status, policy string) {
	now := time.Now().UTC()
	switch policy {
	case "", "now":
		s.GeneratedAt = now.Format(time.RFC3339)
	case "now-5m":
		s.GeneratedAt = now.Add(-5 * time.Minute).Format(time.RFC3339)
	case "now+1h":
		s.GeneratedAt = now.Add(time.Hour).Format(time.RFC3339)
	case "as-is":
		// оставляем как в файле
	}
}

func TestConformance(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("fixtures", "status-*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("образцы не найдены: %v", err)
	}
	for _, f := range files {
		buf, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		var meta fixtureMeta
		if err := json.Unmarshal(buf, &meta); err != nil {
			t.Fatalf("%s: служебные поля не разобраны: %v", f, err)
		}
		if meta.Expect.Code == "" {
			t.Errorf("%s: нет ожидаемого вердикта ($expect), образец непригоден для сверки реализаций", f)
			continue
		}
		var s Status
		if err := json.Unmarshal(buf, &s); err != nil {
			t.Fatalf("%s: вход не разобран: %v", f, err)
		}
		applyStamp(&s, meta.Stamp)

		v := resolve(&s, nil)
		if got := levelNames[v.Level]; got != meta.Expect.Level {
			t.Errorf("%s: цвет %s, ожидался %s (%s)", filepath.Base(f), got, meta.Expect.Level, v.Reason)
		}
		if v.Code != meta.Expect.Code {
			t.Errorf("%s: код причины %q, ожидался %q", filepath.Base(f), v.Code, meta.Expect.Code)
		}
		if v.Unread != meta.Expect.Unread {
			t.Errorf("%s: признак непрочитанного %v, ожидался %v", filepath.Base(f), v.Unread, meta.Expect.Unread)
		}
	}
}
