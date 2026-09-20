package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
)

const defaultLocale = "en"

// Go embeds the reviewable catalogs in the single helper executable. Native
// Windows string tables would require a separate resource compiler in every
// cross-build environment and do not provide runtime locale switching to Go.
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
	activeLocale atomic.Pointer[localeBundle]
	formatToken  = regexp.MustCompile(`%[-+#0 .0-9]*[bcdoOqxXUeEfFgGspvTt]`)
)

func init() { setLocale(defaultLocale) }

func mustLoadCatalogs() map[string]catalog {
	result := make(map[string]catalog, 2)
	for _, locale := range []string{"en", "ru"} {
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
	reference := values[defaultLocale]
	if len(reference) == 0 {
		return errors.New("default locale catalog is empty")
	}
	for locale, messages := range values {
		var missing, extra []string
		for key, value := range reference {
			translated := messages[key]
			if translated == "" {
				missing = append(missing, key)
			} else if fmt.Sprint(formatToken.FindAllString(value, -1)) != fmt.Sprint(formatToken.FindAllString(translated, -1)) {
				return fmt.Errorf("locale %s has different format verbs for %s", locale, key)
			}
		}
		for key := range messages {
			if reference[key] == "" {
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

func setLocale(locale string) {
	messages, ok := catalogs[locale]
	if !ok {
		locale, messages = defaultLocale, catalogs[defaultLocale]
	}
	activeLocale.Store(&localeBundle{locale: locale, messages: messages})
}

func currentLocale() string { return activeLocale.Load().locale }

func tr(key string, args ...any) string {
	value := activeLocale.Load().messages[key]
	if value == "" {
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

type helperArguments struct {
	locale      string
	positionals []string
}

func parseHelperArguments(args []string) (helperArguments, error) {
	result := helperArguments{locale: defaultLocale}
	for i := 0; i < len(args); i++ {
		if args[i] != "--lang" {
			result.positionals = append(result.positionals, args[i])
			continue
		}
		if i+1 >= len(args) {
			return result, errors.New("language must be en or ru")
		}
		i++
		result.locale = strings.ToLower(args[i])
		if result.locale != "en" && result.locale != "ru" {
			return result, errors.New("language must be en or ru")
		}
	}
	return result, nil
}
