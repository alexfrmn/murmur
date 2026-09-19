//go:build windows

package main

// Регрессия на повторную установку. Проверяется содержимое файлов, а не код возврата:
// код возврата и в сломанной версии был верным, врало состояние на диске.
//
// Тест требует прав администратора и создаёт временную службу под отдельным именем.
// Без прав он пропускается: отказ здесь означал бы, что среда не та, а не что код плох.

import (
	"crypto/sha256"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func digest(t *testing.T, path string) string {
	t.Helper()
	buf, err := os.ReadFile(path)
	if err != nil {
		return "нет файла: " + err.Error()
	}
	sum := sha256.Sum256(buf)
	return string(sum[:])
}

func svcExe(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs("murmur-svc.exe")
	if err != nil || !fileExists(p) {
		t.Skip("нужен собранный murmur-svc.exe рядом с тестом")
	}
	return p
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func run(t *testing.T, exe string, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(exe, args...)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestSecondInstallLeavesFilesUntouched(t *testing.T) {
	// Тест ставит настоящую службу Windows, поэтому по умолчанию не гоняется: на общих
	// раннерах это долго и меняет состояние машины. Включается явно.
	if os.Getenv("MURMUR_SVC_E2E") != "1" {
		t.Skip("приёмка службы включается переменной MURMUR_SVC_E2E=1")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("SystemRoot"), "System32", "config", "SAM")); err != nil {
		t.Skip("нужны права администратора")
	}
	exe := svcExe(t)
	dir := t.TempDir()
	entry := filepath.Join(dir, "daemon.mjs")
	if err := os.WriteFile(entry, []byte("setInterval(()=>{},1000);\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("нужен node в PATH")
	}
	name := "MurmurInstallRegression"
	env := []string{
		"MURMUR_SERVICE_NAME=" + name,
		"MURMUR_NODE=" + node,
		"MURMUR_ENTRY=" + entry,
		"MURMUR_WORKDIR=" + dir,
		"MURMUR_DATA_DIR=" + filepath.Join(dir, ".data"),
	}
	defer run(t, exe, env, "uninstall")

	if out, err := run(t, exe, env, "install"); err != nil {
		t.Fatalf("первая установка не удалась: %v\n%s", err, out)
	}

	spec := filepath.Join(os.Getenv("ProgramData"), "Murmur", name+".json")
	state := filepath.Join(os.Getenv("ProgramData"), "Murmur", name+".state.json")
	specBefore, stateBefore := digest(t, spec), digest(t, state)

	out, err := run(t, exe, env, "install")
	if err == nil {
		t.Fatal("повторная установка обязана отказать")
	}
	if specAfter := digest(t, spec); specAfter != specBefore {
		t.Errorf("описание запуска изменено отказавшей командой\n%s", out)
	}
	if stateAfter := digest(t, state); stateAfter != stateBefore {
		t.Errorf("состояние изменено отказавшей командой\n%s", out)
	}
}

// Проверка прав обязана уметь отказывать: файл, в который может писать кто угодно,
// служба исполнять не должна. Без этого теста проверка существует только на словах.
func TestTrustedFileRejectsWorldWritable(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.json")
	if err := os.WriteFile(good, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Отдаём право записи всем: группа Everyone, S-1-1-0.
	if out, err := exec.Command("icacls", good, "/grant", "*S-1-1-0:(W)").CombinedOutput(); err != nil {
		t.Skipf("icacls недоступен: %v\n%s", err, out)
	}
	ok, why, err := trustedFile(good)
	if err != nil {
		t.Fatalf("права не прочитаны: %v", err)
	}
	if ok {
		t.Error("файл с правом записи для всех признан доверенным")
	} else {
		t.Logf("отказано верно: %s", why)
	}
}
