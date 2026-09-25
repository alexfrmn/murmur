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

// Share the exact inputs and expectations used by the engine and Swift consumer.
var fixtureDir = filepath.Join("..", "..", "contracts", "setup", "v1", "fixtures")

func TestDotMeansPendingDeliveryNotUnreadInbox(t *testing.T) {
	for _, fixture := range []string{"status-green.json", "status-yellow.json", "status-red.json", "status-grey.json"} {
		for _, pending := range []int{0, 3} {
			s := load(t, fixture)
			unread := 99
			s.Inbox.Unread = &unread
			s.Wake.Delivery.PendingUndelivered = &pending
			if got := resolve(s, nil).Unread; got != (pending > 0) {
				t.Fatalf("%s pending=%d dot=%v", fixture, pending, got)
			}
		}
	}
}

func load(t *testing.T, name string) *Status {
	t.Helper()
	buf, err := os.ReadFile(filepath.Join(fixtureDir, name))
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
		{"status-green.json", LevelGreen, false},
		{"status-yellow.json", LevelYellow, false},
		{"status-red.json", LevelRed, false},
		{"status-grey.json", LevelGrey, false},
		{"status-no-peers.json", LevelYellow, false},
		{"status-unmeasured.json", LevelGrey, false},
		{"status-pairing-unknown.json", LevelGreen, false},
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

// Пустой список и неизмеренный список — разные вещи. Ноль пиров означает «ещё не
// настроено» и светит жёлтым; null означает «не смог узнать» и гасит в серый.
func TestEmptyIsNotUnknown(t *testing.T) {
	empty := resolve(load(t, "status-no-peers.json"), nil)
	if empty.Level != LevelYellow {
		t.Errorf("пустой список пиров должен быть жёлтым, получен %v (%s)", empty.Level, empty.Reason)
	}
	unknown := resolve(load(t, "status-unmeasured.json"), nil)
	if unknown.Level != LevelGrey {
		t.Errorf("неизмеренные поля должны быть серыми, получен %v (%s)", unknown.Level, unknown.Reason)
	}
	if strings.Contains(unknown.Reason, "peers.list") {
		t.Errorf("в человеческом тексте не должно быть внутреннего пути: %s", unknown.Reason)
	}
}

// Ноль в счётчике и неизмеренный счётчик дают разный цвет: «в очереди пусто» против
// «я не смог посмотреть в очередь».
func TestZeroIsNotNull(t *testing.T) {
	zero := resolve(load(t, "status-green.json"), nil)
	if zero.Level != LevelGreen {
		t.Errorf("измеренные нули должны давать зелёное, получено %v (%s)", zero.Level, zero.Reason)
	}
	s := load(t, "status-green.json")
	s.Outbox.Queue.Failed = nil
	v := resolve(s, nil)
	if v.Level != LevelGrey {
		t.Errorf("неизмеренный счётчик отказов должен гасить в серый, получен %v (%s)", v.Level, v.Reason)
	}
	if strings.Contains(v.Reason, "outbox.queue.failed") {
		t.Errorf("в человеческом тексте не должно быть внутреннего пути: %s", v.Reason)
	}
	if len(v.Missing) != 1 || v.Missing[0] != "outbox.queue.failed" {
		t.Fatalf("диагностический контракт потерял точный путь: %v", v.Missing)
	}
}

// Парность, о которой не знаем, не равна парности подтверждённой: локальные ключи сами
// по себе не доказывают, что пара установлена с обеих сторон.
func TestPairingUnknownIsNotPaired(t *testing.T) {
	snapshot := load(t, "status-pairing-unknown.json")
	v := resolve(snapshot, nil)
	if v.Level != LevelGreen || snapshot.Peers.List[0].Paired != nil {
		t.Errorf("runtime readiness must preserve unknown peer proof: %#v", v)
	}
	no := false
	s := load(t, "status-pairing-unknown.json")
	s.Peers.List[0].Paired = &no
	if v := resolve(s, nil); v.Level != LevelYellow {
		t.Errorf("подтверждённое отсутствие пары — жёлтый, получен %v (%s)", v.Level, v.Reason)
	} else if strings.Contains(v.Reason, s.Peers.List[0].AgentID) {
		t.Errorf("человеческая причина раскрыла идентификатор пира: %s", v.Reason)
	}
}

// Признак неизвестности стоит на том подмножестве, которое читается своим источником:
// очередь измерена из базы, журнал отказов прочитать не удалось — в серое уходит только
// журнал, и он назван, а измеренная очередь зелёной остаётся.
func TestUnknownFollowsSource(t *testing.T) {
	v := resolve(load(t, "status-faultlog-unread.json"), nil)
	if v.Level != LevelGrey {
		t.Errorf("непрочитанный журнал отказов должен гасить в серый, получен %v (%s)", v.Level, v.Reason)
	}
	// Назван путь секции, а не человеческая подпись: перечень сравнивается между
	// реализациями, и русский текст в нём завязал бы контракт на язык интерфейса.
	if len(v.Missing) != 1 || v.Missing[0] != "outbox.faults" {
		t.Errorf("ожидался ровно outbox.faults, получено %v", v.Missing)
	}
	if v.MissingWhy["outbox.faults"] != "source-unreadable" {
		t.Errorf("причина должна быть кодом source-unreadable, получено %q", v.MissingWhy["outbox.faults"])
	}
}

// Известный отказ кричит и тогда, когда часть полей измерить не удалось.
func TestKnownFailureBeatsUnmeasured(t *testing.T) {
	s := load(t, "status-unmeasured.json")
	s.Broker.State = "unauthorized"
	if v := resolve(s, nil); v.Level != LevelYellow {
		t.Errorf("известный отказ брокера должен перебивать незнание, получен %v (%s)", v.Level, v.Reason)
	}
}

func TestGreyKeepsHistory(t *testing.T) {
	v := resolve(load(t, "status-grey.json"), nil)
	if len(v.History) == 0 {
		t.Fatal("в сером состоянии история отказов обязана остаться")
	}
	joined := strings.Join(v.History, " | ")
	for _, want := range []string{"send error", "wake-up failure"} {
		if !strings.Contains(joined, want) {
			t.Errorf("в истории нет %q: %s", want, joined)
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

// Записанное в настройках паузой ещё не является: пока свежего наблюдения нет,
// человек обязан узнать, что его действие не применилось.
func TestPauseConfiguredButNotEffective(t *testing.T) {
	v := resolve(load(t, "status-pause-not-applied.json"), nil)
	joined := strings.Join(v.History, " | ")
	if !strings.Contains(joined, "not effective") {
		t.Errorf("расхождение настроек и действующего состояния должно быть названо: %v", v.History)
	}
	if !strings.Contains(joined, "restart") {
		t.Errorf("нужное действие должно быть названо: %v", v.History)
	}
}

// The colour rule is shared across implementations, so the code stays service.unknown; the
// words tell a previous installation's Service and another program's name apart.
func TestPreviousInstallationServiceKeepsSharedCode(t *testing.T) {
	for detail, key := range map[string]string{"service.previous-installation": "status.servicePrevious", "service.foreign-image": "status.serviceForeign", "service.profile-unverified": "status.serviceUnknown"} {
		s := load(t, "status-green.json")
		s.Service.State, s.Service.Detail = "unknown", detail
		v := resolve(s, nil)
		if v.Level != LevelGrey || v.Code != "service.unknown" || v.Reason != tr(key) {
			t.Fatalf("%s: %+v", detail, v)
		}
	}
}
