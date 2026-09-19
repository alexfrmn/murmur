package main

// Правило цвета — то, ради чего схема существует, поэтому оно проверяется на файлах,
// а не на собранных в тесте структурах: так тест ловит и расхождение схемы с образцами.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
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
		{"status-stale.json", LevelGrey, true},
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

// Отсутствие статуса — тоже состояние, и оно обязано быть серым, а не зелёным по
// умолчанию: именно так значок отличается от украшения.
func TestResolveWithoutData(t *testing.T) {
	if v := resolve(nil, os.ErrNotExist); v.Level != LevelGrey {
		t.Errorf("при ошибке ожидался серый, получен %v", v.Level)
	}
	var s Status
	if v := resolve(&s, nil); v.Level != LevelGrey {
		t.Errorf("пустой статус должен быть серым, получен %v (%s)", v.Level, v.Reason)
	}
}

// Незнакомая версия схемы гаснет в серый: движок и значок обновляются врозь.
func TestUnknownSchemaIsGrey(t *testing.T) {
	s := load(t, "status-green.json")
	s.Schema = "murmur.status/2"
	v := resolve(s, nil)
	if v.Level != LevelGrey {
		t.Errorf("незнакомая схема должна давать серый, получен %v", v.Level)
	}
}

// Каждый цвет обязан следовать из поля. Тест фиксирует соответствие «цвет → поле»,
// чтобы схему нельзя было ужать, не сломав проверку.
func TestEveryLevelHasField(t *testing.T) {
	base := load(t, "status-green.json")

	grey := *base
	grey.Service.State = "stopped"
	if resolve(&grey, nil).Level != LevelGrey {
		t.Error("серый должен следовать из service.state")
	}

	yellow := *base
	yellow.Broker.State = "disconnected"
	if resolve(&yellow, nil).Level != LevelYellow {
		t.Error("жёлтый должен следовать из broker.state")
	}

	red := *base
	red.Wake.LastFault = "хук не ответил"
	if resolve(&red, nil).Level != LevelRed {
		t.Error("красный должен следовать из wake.lastFault")
	}

	clean := *base
	clean.Inbox.Unread = 0
	if resolve(&clean, nil).Unread {
		t.Error("синяя точка должна следовать из inbox.unread")
	}
}

func TestIconsBuild(t *testing.T) {
	for _, unread := range []bool{false, true} {
		ico := iconBytes(colGreen, unread)
		if len(ico) < 64 {
			t.Fatalf("иконка не собралась, длина %d", len(ico))
		}
		// ICO: reserved 0, type 1, count 1 — если заголовок поедет, Windows покажет пустое место.
		if ico[0] != 0 || ico[1] != 0 || ico[2] != 1 || ico[3] != 0 || ico[4] != 1 || ico[5] != 0 {
			t.Errorf("заголовок ICO испорчен: % x", ico[:6])
		}
		if string(ico[22:26]) != "\x89PNG" {
			t.Errorf("кадр не PNG: % x", ico[22:26])
		}
	}
}
