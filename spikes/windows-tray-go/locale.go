package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	defaultLocale = "en"
	localeEnglish = "en"
	localeRussian = "ru"
)

// JSON catalogs are Go resources: they remain reviewable as ordinary localization
// files and are embedded into the single portable executable at build time.
//
//go:embed locales/*.json
var localeFiles embed.FS

type catalog map[string]string

type localeBundle struct {
	locale   string
	messages catalog
}

var (
	catalogs     = mustLoadCatalogs()
	activeBundle atomic.Pointer[localeBundle]
)

func init() { setLocale(defaultLocale) }

func mustLoadCatalogs() map[string]catalog {
	result := make(map[string]catalog, 2)
	for _, locale := range []string{localeEnglish, localeRussian} {
		data, err := localeFiles.ReadFile("locales/" + locale + ".json")
		if err != nil {
			panic(err)
		}
		var messages catalog
		if err := json.Unmarshal(data, &messages); err != nil {
			panic(fmt.Errorf("locale %s: %w", locale, err))
		}
		result[locale] = messages
	}
	if err := validateCatalogs(result); err != nil {
		panic(err)
	}
	return result
}

func validateCatalogs(values map[string]catalog) error {
	reference, ok := values[defaultLocale]
	if !ok || len(reference) == 0 {
		return errors.New("default locale catalog is empty")
	}
	for locale, messages := range values {
		var missing, extra []string
		for key, value := range reference {
			if value == "" {
				return fmt.Errorf("locale %s has an empty value for %s", defaultLocale, key)
			}
			if messages[key] == "" {
				missing = append(missing, key)
			} else if fmt.Sprint(formatTokens(value)) != fmt.Sprint(formatTokens(messages[key])) {
				return fmt.Errorf("locale %s has different format verbs for %s", locale, key)
			}
		}
		for key := range messages {
			if _, exists := reference[key]; !exists {
				extra = append(extra, key)
			}
		}
		sort.Strings(missing)
		sort.Strings(extra)
		if len(missing) > 0 || len(extra) > 0 {
			return fmt.Errorf("locale %s differs from %s: missing=%v extra=%v", locale, defaultLocale, missing, extra)
		}
	}
	return nil
}

var formatToken = regexp.MustCompile(`%[-+#0 .0-9]*[bcdoOqxXUeEfFgGspvTt]`)

func formatTokens(value string) []string { return formatToken.FindAllString(value, -1) }

func validLocale(value string) bool { return value == localeEnglish || value == localeRussian }

func setLocale(locale string) {
	messages, ok := catalogs[locale]
	if !ok {
		locale = defaultLocale
		messages = catalogs[locale]
	}
	activeBundle.Store(&localeBundle{locale: locale, messages: messages})
}

func currentLocale() string {
	if value := activeBundle.Load(); value != nil {
		return value.locale
	}
	return defaultLocale
}

func tr(key string, args ...any) string {
	bundle := activeBundle.Load()
	if bundle == nil {
		return key
	}
	value, ok := bundle.messages[key]
	if !ok {
		value = catalogs[defaultLocale][key]
	}
	if value == "" {
		return key
	}
	if len(args) == 0 {
		return value
	}
	return fmt.Sprintf(value, args...)
}

// localizedError keeps the original error available to errors.Is/errors.As
// while presenting the selected-language message to a person.
type localizedError struct {
	message string
	cause   error
}

func (e *localizedError) Error() string { return e.message }
func (e *localizedError) Unwrap() error { return e.cause }

func trError(key string, cause error, args ...any) error {
	return &localizedError{message: tr(key, args...), cause: cause}
}

type trayPreferences struct {
	Schema    string `json:"schema"`
	Locale    string `json:"locale"`
	GuideSeen bool   `json:"guideSeen,omitempty"`
}

var preferencesMu sync.Mutex

func defaultPreferencesPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	if base == "" {
		return ""
	}
	return filepath.Join(base, "Murmur", "tray-preferences.json")
}

func loadLocalePreference(path string) string {
	preferencesMu.Lock()
	defer preferencesMu.Unlock()
	return loadTrayPreferences(path).Locale
}

func guideSeenPreference(path string) bool {
	preferencesMu.Lock()
	defer preferencesMu.Unlock()
	return loadTrayPreferences(path).GuideSeen
}

func loadTrayPreferences(path string) trayPreferences {
	defaults := trayPreferences{Schema: "murmur.tray-preferences/1", Locale: defaultLocale}
	if path == "" {
		return defaults
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return defaults
	}
	var value trayPreferences
	if json.Unmarshal(data, &value) != nil || value.Schema != "murmur.tray-preferences/1" || !validLocale(value.Locale) {
		return defaults
	}
	return value
}

func saveLocalePreference(path, locale string) error {
	if path == "" || !validLocale(locale) {
		return errors.New("invalid locale preference")
	}
	preferencesMu.Lock()
	defer preferencesMu.Unlock()
	value := loadTrayPreferences(path)
	value.Locale = locale
	return saveTrayPreferences(path, value)
}

func saveGuideSeenPreference(path string) error {
	if path == "" {
		return errors.New("invalid tray preference path")
	}
	preferencesMu.Lock()
	defer preferencesMu.Unlock()
	value := loadTrayPreferences(path)
	value.GuideSeen = true
	return saveTrayPreferences(path, value)
}

func saveTrayPreferences(path string, value trayPreferences) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o600)
}

type trayArguments struct {
	mode           string
	target         string
	locale         string
	localeExplicit bool
	launcherStart  bool
}

func parseTrayArguments(args []string) (trayArguments, error) {
	result := trayArguments{locale: loadLocalePreference(defaultPreferencesPath())}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--lang":
			if i+1 >= len(args) || !validLocale(strings.ToLower(args[i+1])) {
				return result, errors.New(tr("args.locale"))
			}
			i++
			result.locale = strings.ToLower(args[i])
			result.localeExplicit = true
		case "--launcher-start":
			result.launcherStart = true
		case "--launch", "--check-profile":
			if result.mode != "" {
				return result, errors.New(tr("args.command"))
			}
			result.mode = args[i]
		case "--stamp-now", "--dump-icons":
			if result.mode != "" || i+1 >= len(args) {
				return result, errors.New(tr("args.command"))
			}
			result.mode, result.target = args[i], args[i+1]
			i++
		default:
			return result, fmt.Errorf(tr("args.unknown"), args[i])
		}
	}
	return result, nil
}

func peerCount(n int) string {
	if currentLocale() == localeRussian {
		form := "count.peers.many"
		if mod100 := n % 100; mod100 < 11 || mod100 > 14 {
			switch n % 10 {
			case 1:
				form = "count.peers.one"
			case 2, 3, 4:
				form = "count.peers.few"
			}
		}
		return tr(form, n)
	}
	if n == 1 {
		return tr("count.peers.one", n)
	}
	return tr("count.peers.many", n)
}

func messageCount(n int) string {
	if currentLocale() == localeRussian {
		form := "count.messages.many"
		if mod100 := n % 100; mod100 < 11 || mod100 > 14 {
			switch n % 10 {
			case 1:
				form = "count.messages.one"
			case 2, 3, 4:
				form = "count.messages.few"
			}
		}
		return tr(form, n)
	}
	if n == 1 {
		return tr("count.messages.one", n)
	}
	return tr("count.messages.many", n)
}
