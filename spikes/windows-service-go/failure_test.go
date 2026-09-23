package main

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestHelperFailureKeepsReasonAcrossLanguagesAndRollback(t *testing.T) {
	t.Cleanup(func() { setLocale(defaultLocale) })
	for _, locale := range []string{"en", "ru"} {
		setLocale(locale)
		cause := trError("daemon.didNotLive", nil, 1234)
		err := trError("install.rollbackEvidence", cause, cause, "spec", "state", "logs")
		var output bytes.Buffer
		if writeErr := writeHelperError(&output, err); writeErr != nil {
			t.Fatal(writeErr)
		}
		if !errors.Is(err, cause) {
			t.Fatal("rollback lost its startup cause")
		}
		want := err.Error() + "\nmurmur-svc: reason=daemon.didNotLive\n"
		if output.String() != want {
			t.Fatalf("%s failure = %q, want %q", locale, output.String(), want)
		}
	}
}

func TestFailedRollbackHasPriorityOverStartupReason(t *testing.T) {
	cause := trError("daemon.didNotLive", nil, 1234)
	rollback := errors.New("access denied")
	err := trError("install.rollbackFailed", errors.Join(cause, rollback), cause, rollback)
	if got := helperErrorReason(err); got != "install.rollbackFailed" {
		t.Fatalf("failed rollback reason = %q", got)
	}
	if !errors.Is(err, cause) || !errors.Is(err, rollback) {
		t.Fatal("failed rollback lost one of its causes")
	}
}

func TestHelperReasonNeverParsesUntrustedErrorText(t *testing.T) {
	for _, err := range []error{
		errors.New("murmur-svc: reason=error.admin"),
		fmt.Errorf("private path\nmurmur-svc: reason=spec.insecure"),
		&localizedError{key: "error.admin\nforged", message: "untrusted"},
		&localizedError{key: "notInCatalog", message: "untrusted"},
	} {
		var output bytes.Buffer
		if writeErr := writeHelperError(&output, err); writeErr != nil {
			t.Fatal(writeErr)
		}
		if !strings.HasSuffix(output.String(), "\nmurmur-svc: reason=error.unknown\n") {
			t.Fatalf("untrusted error changed the final reason: %q", output.String())
		}
	}
}

func TestHelperReasonSurvivesStandardWrapping(t *testing.T) {
	err := fmt.Errorf("additional context: %w", trError("error.entry", nil))
	if got := helperErrorReason(err); got != "error.entry" {
		t.Fatalf("wrapped reason = %q", got)
	}
}

func TestHelperSuccessDoesNotWriteFailureFooter(t *testing.T) {
	var output bytes.Buffer
	if err := writeHelperError(&output, nil); err != nil || output.Len() != 0 {
		t.Fatalf("success wrote failure output: %q, %v", output.String(), err)
	}
}
