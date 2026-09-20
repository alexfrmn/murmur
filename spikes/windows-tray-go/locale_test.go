package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestLocaleCatalogsHaveExactKeyParity(t *testing.T) {
	if err := validateCatalogs(catalogs); err != nil {
		t.Fatal(err)
	}
}

func TestEveryStaticMessageKeyExists(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	keyPattern := regexp.MustCompile(`tr\("([^"]+)"`)
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range keyPattern.FindAllSubmatch(data, -1) {
			key := string(match[1])
			if catalogs[defaultLocale][key] == "" {
				t.Errorf("%s uses missing message key %q", file, key)
			}
		}
	}
}

func TestEnglishIsDefaultAndAmbientLocaleIsIgnored(t *testing.T) {
	previous := currentLocale()
	t.Cleanup(func() { setLocale(previous) })
	setLocale(defaultLocale)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("MURMUR_LOCALE", localeRussian)
	args, err := parseTrayArguments(nil)
	if err != nil {
		t.Fatal(err)
	}
	if args.locale != localeEnglish || args.localeExplicit {
		t.Fatalf("default locale = %#v", args)
	}
	if got := resolve(nil, nil).Reason; got != "Status has not been collected yet" {
		t.Fatalf("default status text = %q", got)
	}
}

func TestExplicitRussianAndPreferencePersistence(t *testing.T) {
	previous := currentLocale()
	t.Cleanup(func() { setLocale(previous) })
	path := filepath.Join(t.TempDir(), "prefs", "tray-preferences.json")
	if got := loadLocalePreference(path); got != localeEnglish {
		t.Fatalf("missing preference = %q", got)
	}
	if err := saveLocalePreference(path, localeRussian); err != nil {
		t.Fatal(err)
	}
	if got := loadLocalePreference(path); got != localeRussian {
		t.Fatalf("persisted preference = %q", got)
	}
	setLocale(localeRussian)
	if got := resolve(nil, nil).Reason; got != "Статус ещё не снят" {
		t.Fatalf("Russian status text = %q", got)
	}
	for n, want := range map[int]string{0: "0 пиров", 1: "1 пир", 2: "2 пира", 5: "5 пиров", 11: "11 пиров", 21: "21 пир", 104: "104 пира"} {
		if got := peerCount(n); got != want {
			t.Errorf("peerCount(%d) = %q, want %q", n, got, want)
		}
	}
	setLocale(localeEnglish)
	if peerCount(1) != "1 peer" || peerCount(2) != "2 peers" || messageCount(1) != "1 message" || messageCount(2) != "2 messages" {
		t.Fatal("English count forms are incorrect")
	}
}

func TestPreferenceRejectsUnknownOrMalformedLocale(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray-preferences.json")
	for _, data := range []string{
		`{"schema":"murmur.tray-preferences/1","locale":"de"}`,
		`{"schema":"murmur.tray-preferences/2","locale":"ru"}`,
		`not-json`,
	} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := loadLocalePreference(path); got != localeEnglish {
			t.Fatalf("invalid preference selected %q for %q", got, data)
		}
	}
	if err := saveLocalePreference(path, "de"); err == nil {
		t.Fatal("unknown locale persisted")
	}
}

func TestExplicitLocaleArgumentsAreBounded(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	got, err := parseTrayArguments([]string{"--check-profile", "--lang", "ru"})
	if err != nil || got.mode != "--check-profile" || got.locale != localeRussian || !got.localeExplicit {
		t.Fatalf("explicit locale = %#v, %v", got, err)
	}
	for _, args := range [][]string{{"--lang", "de"}, {"--lang"}, {"--check-profile", "--launch"}, {"--wat"}} {
		if _, err := parseTrayArguments(args); err == nil || strings.TrimSpace(err.Error()) == "" {
			t.Fatalf("accepted invalid arguments %q", args)
		}
	}
}
