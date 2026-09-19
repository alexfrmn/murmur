package main

// Правило цвета — то, ради чего схема существует, поэтому оно проверяется на файлах,
// а не на структурах, собранных в тесте: так тест ловит и расхождение схемы с образцами.
//
// Образцы лежат с датой из эпохи, и тест сам ставит свежую: константа из будущего в
// файле отключала бы проверку свежести во всех остальных случаях — ровно так первая
// версия этих тестов и проверяла зелёное, никогда не проверяя возраст.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func load(t *testing.T, name string) *Status {
	t.Helper()
	buf, err := os.ReadFile(filepath.Join("fixtures", name))
	if err != nil {
		t.Fatalf("образец %s не прочитан: %v", name, err)
	}
	var s Status
	if err := json.Unmarshal(buf, &s); err != nil {
		t.Fatalf("образец %s не разобран: %v", name, err)
	}
	s.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	return &s
}

func TestResolveLevels(t *testing.T) {
	cases := []struct {
		fixture string
		want    Level
		unread  bool
	}{
		{"status-green.json", LevelGreen, true},
		{"status-yellow.json", LevelYellow, true},
		{"status-red.json", LevelRed, true},
		{"status-grey.json", LevelGrey, true},
		{"status-no-peers.json", LevelYellow, false},
		{"status-unknown-sections.json", LevelGrey, true},
	}
	for _, c := range cases {
		v := resolve(load(t, c.fixture), nil)
		if v.Level != c.want {
			t.Errorf("%s: цвет %v, ожидался %v (%s)", c.fixture, v.Level, c.want, v.Reason)
		}
		if v.Unread != c.unread {
			t.Errorf("%s: признак непрочитанного %v, ожидался %v", c.fixture, v.Unread, c.unread)
		}
	}
}

// Возраст снимка: устаревший, из будущего и неразобранный — все три серые. Средний
// случай раньше проходил насквозь, потому что отрицательный возраст не больше порога.
func TestSnapshotAge(t *testing.T) {
	cases := []struct {
		name  string
		stamp string
	}{
		{"устаревший", time.Now().Add(-5 * time.Minute).UTC().Format(time.RFC3339)},
		{"из будущего", time.Now().Add(time.Hour).UTC().Format(time.RFC3339)},
		{"неразобранный", "вчера вечером"},
		{"пустой", ""},
	}
	for _, c := range cases {
		s := load(t, "status-green.json")
		s.GeneratedAt = c.stamp
		if v := resolve(s, nil); v.Level != LevelGrey {
			t.Errorf("%s снимок должен давать серый, получен %v (%s)", c.name, v.Level, v.Reason)
		}
	}
}

// Отсутствие статуса — тоже состояние, и оно серое, а не зелёное по умолчанию.
func TestResolveWithoutData(t *testing.T) {
	if v := resolve(nil, os.ErrNotExist); v.Level != LevelGrey {
		t.Errorf("при ошибке ожидался серый, получен %v", v.Level)
	}
	var s Status
	if v := resolve(&s, nil); v.Level != LevelGrey {
		t.Errorf("пустой статус должен быть серым, получен %v (%s)", v.Level, v.Reason)
	}
}

func TestSchemaVersioning(t *testing.T) {
	s := load(t, "status-green.json")
	s.Schema = "murmur.status/2"
	if v := resolve(s, nil); v.Level != LevelGrey {
		t.Errorf("чужой мажор должен гасить в серый, получен %v", v.Level)
	}
	// Минорная добавка не ломает значок: движок обязан иметь право добавить поле.
	s = load(t, "status-green.json")
	s.Schema = "murmur.status/1.3"
	if v := resolve(s, nil); v.Level != LevelGreen {
		t.Errorf("минорная версия должна приниматься, получен %v (%s)", v.Level, v.Reason)
	}
}

// Пустая секция и непрочитанная секция — разные вещи. Ноль пиров означает «ещё не
// настроено» и светит жёлтым; непрочитанные пиры означают «не знаю» и гасят в серый.
func TestEmptyIsNotUnknown(t *testing.T) {
	empty := resolve(load(t, "status-no-peers.json"), nil)
	if empty.Level != LevelYellow {
		t.Errorf("ноль пиров должен быть жёлтым, получен %v (%s)", empty.Level, empty.Reason)
	}
	unknown := resolve(load(t, "status-unknown-sections.json"), nil)
	if unknown.Level != LevelGrey {
		t.Errorf("непрочитанные секции должны быть серыми, получен %v (%s)", unknown.Level, unknown.Reason)
	}
}

// Известный отказ кричит даже тогда, когда часть секций прочитать не удалось.
func TestKnownFailureBeatsUnknownSection(t *testing.T) {
	s := load(t, "status-unknown-sections.json")
	s.Broker.State = "unauthorized"
	if v := resolve(s, nil); v.Level != LevelYellow {
		t.Errorf("известный отказ брокера должен перебивать незнание, получен %v (%s)", v.Level, v.Reason)
	}
}

// То, что не поместилось в цвет, остаётся текстом: серый без истории читается как
// «отказов не было».
func TestGreyKeepsHistory(t *testing.T) {
	v := resolve(load(t, "status-grey.json"), nil)
	if len(v.History) == 0 {
		t.Fatal("в сером состоянии история отказов обязана остаться")
	}
	joined := strings.Join(v.History, " | ")
	for _, want := range []string{"ошибка отправки", "сбой пробуждения"} {
		if !strings.Contains(joined, want) {
			t.Errorf("в истории нет %q: %s", want, joined)
		}
	}
}

func TestPlural(t *testing.T) {
	cases := map[int]string{0: "0 пиров", 1: "1 пир", 2: "2 пира", 5: "5 пиров", 11: "11 пиров", 21: "21 пир", 104: "104 пира"}
	for n, want := range cases {
		if got := plural(n, "пир", "пира", "пиров"); got != want {
			t.Errorf("plural(%d) = %q, ожидалось %q", n, got, want)
		}
	}
}

func TestIconsBuild(t *testing.T) {
	for _, unread := range []bool{false, true} {
		ico := iconBytes(colGreen, unread)
		if len(ico) < 64 {
			t.Fatalf("иконка не собралась, длина %d", len(ico))
		}
		if ico[0] != 0 || ico[1] != 0 || ico[2] != 1 || ico[3] != 0 || ico[4] != 1 || ico[5] != 0 {
			t.Errorf("заголовок ICO испорчен: % x", ico[:6])
		}
		if string(ico[22:26]) != "\x89PNG" {
			t.Errorf("кадр не PNG: % x", ico[22:26])
		}
	}
}
