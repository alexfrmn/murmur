//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestSCMImagePathKeepsQuotedExecutableAndServiceBinding(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Program Files", "Murmur")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	self := filepath.Join(dir, "murmur-svc.exe")
	if err := os.WriteFile(self, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	name := "MurmurOwnedTest"
	if err := validateServiceImage(windows.ComposeCommandLine([]string{self, "run", name}), self, name); err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"", " ", windows.ComposeCommandLine([]string{self, "run", "OtherProfile"}), windows.ComposeCommandLine([]string{self, "status", name}), windows.ComposeCommandLine([]string{self, "run", name, "extra"}), windows.ComposeCommandLine([]string{self, "run", name, "--lang", "ru"}), `C:\missing.exe run MurmurOwnedTest`} {
		if err := validateServiceImage(line, self, name); err == nil {
			t.Errorf("accepted foreign or malformed ImagePath %q", line)
		}
	}
}

func TestOnlyMissingServiceMeansAbsent(t *testing.T) {
	if !serviceAbsent(windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		t.Fatal("missing service not recognized")
	}
	for _, err := range []error{nil, windows.ERROR_ACCESS_DENIED, windows.ERROR_INVALID_HANDLE, errors.New("RPC disconnected")} {
		if serviceAbsent(err) {
			t.Fatalf("treated manager error as absent: %v", err)
		}
	}
}

func TestMissingHistoryIsNotMeasuredZero(t *testing.T) {
	t.Setenv("ProgramData", t.TempDir())
	t.Setenv("MURMUR_SERVICE_NAME", "MurmurMissingHistoryTest")
	if _, err := readStateChecked(); err == nil {
		t.Fatal("missing state was reported as measured zero")
	}
}

func TestPublicMetadataCannotOverlapPrivateProfile(t *testing.T) {
	root := t.TempDir()
	metadata := filepath.Join(root, "Murmur")
	for _, profile := range []string{metadata, filepath.Join(metadata, "keys"), root} {
		if err := rejectMetadataOverlap(profile, metadata); err == nil {
			t.Errorf("accepted overlap %s", profile)
		}
	}
	if err := rejectMetadataOverlap(filepath.Join(root, "PrivateProfile"), metadata); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(metadata); !os.IsNotExist(err) {
		t.Fatal("validation created metadata")
	}
}

func TestExpectedProfileRejectsOtherDataDirectory(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "alice")
	spec := &launchSpec{DataDir: profile}
	t.Setenv("DATA_DIR", filepath.Join(root, "bob"))
	t.Setenv("MURMUR_DATA_DIR", "")
	if err := requireExpectedProfile(spec); err == nil {
		t.Fatal("accepted another selected profile")
	}
	t.Setenv("DATA_DIR", profile)
	t.Setenv("MURMUR_DATA_DIR", filepath.Join(root, "bob"))
	if _, err := selectedDataDir(profile); err == nil {
		t.Fatal("accepted conflicting directory names")
	}
}

func TestServiceNameCannotEscapeMetadataDirectory(t *testing.T) {
	for _, name := range []string{"", "..", `..\other`, "../other", `C:\outside`, "name with space"} {
		if validateServiceName(name) == nil {
			t.Errorf("accepted %q", name)
		}
	}
	if err := validateServiceName("MurmurDaemon-123_abc"); err != nil {
		t.Fatal(err)
	}
}

func TestReadOnlySCMObservesAbsentServiceWithoutElevation(t *testing.T) {
	m, err := connectReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Disconnect()
	s, err := openReadOnly(m, "MurmurAbsentForReadOnlyUnitTest0919")
	if s != nil {
		s.Close()
		t.Fatal("test service unexpectedly exists")
	}
	if !serviceAbsent(err) {
		t.Fatalf("expected observed absence, got %v", err)
	}
}

func TestExistingPathIdentityAllowsHardlinksButNotDifferentFiles(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first")
	alias := filepath.Join(dir, "alias")
	other := filepath.Join(dir, "other")
	if err := os.WriteFile(first, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(first, alias); err != nil {
		t.Fatal(err)
	}
	if !sameLocation(first, alias) || sameLocation(first, other) {
		t.Fatal("path identity lost")
	}
}
func TestCaseSensitiveProfilesRemainDistinct(t *testing.T) {
	dir := t.TempDir()
	if out, err := exec.Command("fsutil", "file", "setCaseSensitiveInfo", dir, "enable").CombinedOutput(); err != nil {
		t.Skipf("case-sensitive directory unavailable: %v %s", err, out)
	}
	one, two := filepath.Join(dir, "profile"), filepath.Join(dir, "PROFILE")
	if err := os.Mkdir(one, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(two, 0700); err != nil {
		t.Fatal(err)
	}
	if sameLocation(one, two) {
		t.Fatal("different case-sensitive profiles treated as identical")
	}
}
