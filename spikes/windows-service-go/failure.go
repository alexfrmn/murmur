package main

import (
	"errors"
	"fmt"
	"io"
	"regexp"
)

var helperReasonPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9.]*$`)

// Only typed catalog keys cross the machine-readable boundary. In particular,
// an OS error or a path containing a forged footer cannot supply its own key.
func helperErrorReason(err error) string {
	var localized *localizedError
	if !errors.As(err, &localized) {
		return "error.unknown"
	}
	// Successful cleanup adds diagnostic context, but the caller still needs the
	// startup failure. A failed rollback keeps its own, more urgent reason.
	if localized.key == "install.rollbackEvidence" {
		return helperErrorReason(localized.cause)
	}
	if !helperReasonPattern.MatchString(localized.key) || catalogs[defaultLocale][localized.key] == "" {
		return "error.unknown"
	}
	return localized.key
}

func writeHelperReason(w io.Writer, err error) error {
	_, writeErr := fmt.Fprintf(w, "murmur-svc: reason=%s\n", helperErrorReason(err))
	return writeErr
}

func writeHelperError(w io.Writer, err error) error {
	if err == nil {
		return nil
	}
	if _, writeErr := fmt.Fprintln(w, err); writeErr != nil {
		return writeErr
	}
	return writeHelperReason(w, err)
}
