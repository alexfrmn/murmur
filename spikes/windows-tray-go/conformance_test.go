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
	Level      string            `json:"level"`
	Unread     bool              `json:"unread"`
	Code       string            `json:"code"`
	Missing    []string          `json:"missing"`
	MissingWhy map[string]string `json:"missingWhy"`
}

type fixtureMeta struct {
	Stamp  string      `json:"$stamp"`
	Expect expectation `json:"$expect"`
}

var levelNames = map[Level]string{
	LevelGrey: "grey", LevelRed: "red", LevelYellow: "yellow", LevelGreen: "green",
}

// stampValue реализует политику даты снимка. Без неё образцы протухают, а с константой
// из будущего проверка свежести молча выключается — так и было в первой версии.
func stampValue(policy string, current any) any {
	now := time.Now().UTC()
	switch policy {
	case "", "now":
		return now.Format(time.RFC3339)
	case "now-5m":
		return now.Add(-5 * time.Minute).Format(time.RFC3339)
	case "now+1h":
		return now.Add(time.Hour).Format(time.RFC3339)
	default: // as-is
		return current
	}
}

func TestConformance(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(fixtureDir, "status-*.json"))
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
		// Штамп ставится в сыром документе: разбор с проверками — часть проверяемого
		// поведения, обходить его в тесте нельзя.
		var doc map[string]any
		if err := json.Unmarshal(buf, &doc); err != nil {
			t.Fatalf("%s: документ не разобран: %v", f, err)
		}
		doc["generatedAt"] = stampValue(meta.Stamp, doc["generatedAt"])
		stamped, err := json.Marshal(doc)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		s, perr := parseStatus(stamped)
		v := resolve(s, perr)
		if got := levelNames[v.Level]; got != meta.Expect.Level {
			t.Errorf("%s: цвет %s, ожидался %s (%s)", filepath.Base(f), got, meta.Expect.Level, v.Reason)
		}
		if v.Code != meta.Expect.Code {
			t.Errorf("%s: код причины %q, ожидался %q", filepath.Base(f), v.Code, meta.Expect.Code)
		}
		// Перечень недостающих полей сравнивается как множество: один код «не измерено»
		// на разных платформах может означать разную нехватку, и тогда цвет сойдётся, а
		// человек прочитает разное.
		if len(meta.Expect.Missing) > 0 || len(v.Missing) > 0 {
			if !sameSet(v.Missing, meta.Expect.Missing) {
				t.Errorf("%s: недостающие поля %v, ожидались %v", filepath.Base(f), v.Missing, meta.Expect.Missing)
			}
		}
		for path, code := range meta.Expect.MissingWhy {
			if v.MissingWhy[path] != code {
				t.Errorf("%s: причина для %s — %q, ожидалась %q", filepath.Base(f), path, v.MissingWhy[path], code)
			}
		}
		if v.Unread != meta.Expect.Unread {
			t.Errorf("%s: признак непрочитанного %v, ожидался %v", filepath.Base(f), v.Unread, meta.Expect.Unread)
		}
	}
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, s := range a {
		seen[s]++
	}
	for _, s := range b {
		seen[s]--
		if seen[s] < 0 {
			return false
		}
	}
	return true
}

// Образцы доктора проверяются на само правило цепочки: отказ останавливает её, дальше
// идут пропуски со ссылкой на остановивший этап. Отрицательный образец обязан быть
// отвергнут — иначе проверка правила существует только в моей голове.
func TestDoctorChainRule(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(fixtureDir, "doctor-*.json"))
	if len(files) == 0 {
		t.Fatal("образцы доктора не найдены")
	}
	for _, f := range files {
		buf, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		var meta struct {
			Expect struct {
				Valid bool `json:"valid"`
			} `json:"$expect"`
		}
		if err := json.Unmarshal(buf, &meta); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		var d Doctor
		if err := json.Unmarshal(buf, &d); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		err = validateDoctor(&d)
		if meta.Expect.Valid && err != nil {
			t.Errorf("%s: образец должен проходить правило, получено: %v", filepath.Base(f), err)
		}
		if !meta.Expect.Valid && err == nil {
			t.Errorf("%s: образец нарушает правило цепочки и обязан быть отвергнут", filepath.Base(f))
		}
	}
}
