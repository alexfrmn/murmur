//go:build windows

package main

// Доказательство хранилища проверяется на живом процессе, а не на заглушке: заглушка не
// держит файл открытым, и весь смысл проверки пропал бы.
//
// Запуск: MURMUR_PROBE_DATADIR=<каталог> MURMUR_PROBE_PID=<pid> go test -run Store

import (
	"os"
	"strconv"
	"testing"
)

func TestObservedStoreOnLiveDaemon(t *testing.T) {
	dir := os.Getenv("MURMUR_PROBE_DATADIR")
	pidText := os.Getenv("MURMUR_PROBE_PID")
	if dir == "" || pidText == "" {
		t.Skip("нужен живой демон: задайте MURMUR_PROBE_DATADIR и MURMUR_PROBE_PID")
	}
	pid, err := strconv.Atoi(pidText)
	if err != nil {
		t.Fatalf("pid не разобран: %v", err)
	}
	path, why := observedStore(dir, pid)
	if path == "" {
		t.Fatalf("свидетельства нет: %s", why)
	}
	t.Logf("демон %d держит %s", pid, path)
}

// Чужой pid не должен давать свидетельства: иначе проверка подтверждала бы что угодно.
func TestObservedStoreRejectsForeignPID(t *testing.T) {
	dir := os.Getenv("MURMUR_PROBE_DATADIR")
	if dir == "" {
		t.Skip("нужен каталог данных живого демона")
	}
	if path, why := observedStore(dir, os.Getpid()); path != "" {
		t.Errorf("свидетельство выдано на чужой процесс: %s", path)
	} else {
		t.Logf("отказано верно: %s", why)
	}
}
