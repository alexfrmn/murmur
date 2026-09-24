//go:build windows

package main

// Доказательство хранилища проверяется на живом процессе, а не на заглушке: заглушка не
// держит файл открытым, и весь смысл проверки пропал бы.
//
// Запуск: MURMUR_PROBE_DATADIR=<каталог> MURMUR_PROBE_PID=<pid> go test -run Store

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestStoreProofUsesDisposableOpenFileWithoutAService(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	file, err := os.Create(filepath.Join(dir, "murmur.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	stdout := os.Stdout
	os.Stdout = writer
	err = printStoreProof([]string{strconv.Itoa(os.Getpid())})
	os.Stdout = stdout
	writer.Close()
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var proof struct {
		Schema            string  `json:"schema"`
		PID               int     `json:"pid"`
		ObservedStorePath *string `json:"observedStorePath"`
	}
	if err := json.Unmarshal(data, &proof); err != nil {
		t.Fatal(err)
	}
	if proof.Schema != "murmur.store-proof/1" || proof.PID != os.Getpid() || proof.ObservedStorePath == nil || *proof.ObservedStorePath != file.Name() {
		t.Fatalf("actual open file was not proven: %s", data)
	}
}

func TestStoreProofRejectsInvalidPIDAndRelativePath(t *testing.T) {
	t.Setenv("DATA_DIR", t.TempDir())
	for _, args := range [][]string{nil, {"0"}, {"-1"}, {"1.5"}, {"4294967296"}, {"1", "2"}} {
		if err := printStoreProof(args); err == nil {
			t.Fatalf("accepted invalid PID: %v", args)
		}
	}
	t.Setenv("DATA_DIR", "relative")
	if err := printStoreProof([]string{"1"}); err == nil {
		t.Fatal("accepted relative store")
	}
}

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
