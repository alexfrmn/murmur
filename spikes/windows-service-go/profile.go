//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Resolve existing ancestors before comparing locations, including junctions.
// Missing descendants do not have to be created to check this safety boundary.
func canonicalLocation(value string) (string, error) {
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("service.path-must-be-absolute")
	}
	current := filepath.Clean(value)
	var tail []string
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, tail[i])
			}
			return filepath.Clean(resolved), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		tail = append(tail, filepath.Base(current))
		current = parent
	}
}

func sameLocation(a, b string) bool {
	first, err := canonicalLocation(a)
	if err != nil {
		return false
	}
	second, err := canonicalLocation(b)
	if err != nil {
		return false
	}
	// Windows service paths are conservatively case-insensitive. Refusing an
	// overlap on a case-sensitive subtree is preferable to broadening key ACLs.
	return strings.EqualFold(first, second)
}

func rejectMetadataOverlap(profile, metadata string) error {
	first, err := canonicalLocation(profile)
	if err != nil {
		return err
	}
	second, err := canonicalLocation(metadata)
	if err != nil {
		return err
	}
	a, b := strings.ToLower(first), strings.ToLower(second)
	contains := func(parent, child string) bool {
		relative, err := filepath.Rel(parent, child)
		return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
	}
	if contains(a, b) || contains(b, a) {
		return fmt.Errorf("service.profile-overlaps-metadata: choose a private profile outside %s", metadata)
	}
	return nil
}

func selectedDataDir(fallback string) (string, error) {
	canonical, present := os.LookupEnv("DATA_DIR")
	legacy := os.Getenv("MURMUR_DATA_DIR")
	if present {
		if canonical == "" {
			return "", fmt.Errorf("service.data-dir-empty: DATA_DIR is explicitly empty")
		}
		if legacy != "" && !sameLocation(canonical, legacy) {
			return "", fmt.Errorf("service.data-dir-conflict: DATA_DIR and MURMUR_DATA_DIR select different profiles")
		}
		return canonical, nil
	}
	if legacy != "" {
		return legacy, nil
	}
	return fallback, nil
}

// CLI supplies expected paths for every operation. Bare administrative helper
// use remains possible by service name, but never bypasses executable ownership.
func requireExpectedProfile(spec *launchSpec) error {
	data, err := selectedDataDir(spec.DataDir)
	if err != nil {
		return err
	}
	if !sameLocation(data, spec.DataDir) {
		return fmt.Errorf("service.profile-mismatch: DATA_DIR")
	}
	for key, actual := range map[string]string{"MURMUR_NODE": spec.Node, "MURMUR_ENTRY": spec.Entry, "MURMUR_WORKDIR": spec.WorkDir} {
		if expected, present := os.LookupEnv(key); present && !sameLocation(expected, actual) {
			return fmt.Errorf("service.profile-mismatch: %s", key)
		}
	}
	return nil
}

var serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$`)

func validateServiceName(name string) error {
	if !serviceNamePattern.MatchString(name) {
		return fmt.Errorf("service.name-invalid")
	}
	return nil
}
