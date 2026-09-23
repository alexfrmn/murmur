package main

import (
	"errors"
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
	keyPattern := regexp.MustCompile(`tr(?:Error)?\("([^"]+)"`)
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

func TestHelperDefaultsToEnglishAndIgnoresAmbientLocale(t *testing.T) {
	t.Setenv("MURMUR_LOCALE", "ru")
	got, err := parseHelperArguments([]string{"status"})
	if err != nil {
		t.Fatal(err)
	}
	if got.locale != "en" || len(got.positionals) != 1 || got.positionals[0] != "status" {
		t.Fatalf("default arguments = %#v", got)
	}
	setLocale(got.locale)
	t.Cleanup(func() { setLocale(defaultLocale) })
	if text := tr("service.started"); text != "Service started and confirmed" {
		t.Fatalf("default message = %q", text)
	}
}

func TestHelperAcceptsExplicitRussianWithoutChangingPositionals(t *testing.T) {
	for _, args := range [][]string{
		{"--lang", "ru", "status"},
		{"run", "MurmurDaemon", "--lang", "ru"},
	} {
		got, err := parseHelperArguments(args)
		if err != nil {
			t.Fatal(err)
		}
		if got.locale != "ru" {
			t.Fatalf("locale for %q = %q", args, got.locale)
		}
		want := []string{"status"}
		if args[0] == "run" {
			want = []string{"run", "MurmurDaemon"}
		}
		if strings.Join(got.positionals, "|") != strings.Join(want, "|") {
			t.Fatalf("positionals for %q = %q, want %q", args, got.positionals, want)
		}
	}
	setLocale("ru")
	t.Cleanup(func() { setLocale(defaultLocale) })
	if text := tr("service.started"); text != "Служба запущена и подтверждена" {
		t.Fatalf("Russian message = %q", text)
	}
}

func TestHelperRejectsMissingOrUnknownLanguage(t *testing.T) {
	for _, args := range [][]string{{"--lang"}, {"--lang", "de", "status"}} {
		if _, err := parseHelperArguments(args); err == nil || strings.TrimSpace(err.Error()) == "" {
			t.Fatalf("accepted invalid arguments %q", args)
		}
	}
}

func TestLocalizedErrorPreservesCause(t *testing.T) {
	cause := errors.New("sentinel")
	err := trError("error.admin", cause, cause)
	if !errors.Is(err, cause) {
		t.Fatalf("localized error lost its cause: %v", err)
	}
	var localized *localizedError
	if !errors.As(err, &localized) || localized.cause != cause {
		t.Fatalf("localized error cannot be inspected: %#v", err)
	}
}
