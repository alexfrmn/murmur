package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

type presentationContract struct {
	Schema   string                       `json:"schema"`
	Messages map[string]map[string]string `json:"messages"`
	Rules    []struct {
		Codes     []string `json:"codes"`
		Missing   string   `json:"missing"`
		MessageID string   `json:"messageId"`
	} `json:"rules"`
	Exposure struct {
		DisplayedAllows []string `json:"displayedReasonAllows"`
		Diagnostics     []string `json:"diagnosticsRetain"`
		PairingPattern  string   `json:"onlyPeerPairingFieldPattern"`
	} `json:"exposure"`
}

type presentationFixtures struct {
	Schema string `json:"schema"`
	Cases  []struct {
		Name                 string   `json:"name"`
		StatusFixture        string   `json:"statusFixture"`
		ExpectedCode         string   `json:"expectedCode"`
		ExpectedMessageID    string   `json:"expectedMessageId"`
		Forbidden            []string `json:"forbiddenDisplayedSubstrings"`
		RequiredMissingPaths []string `json:"requiredDiagnosticMissing"`
	} `json:"cases"`
}

func TestLocaleCatalogsHaveExactKeyParity(t *testing.T) {
	if err := validateCatalogs(catalogs); err != nil {
		t.Fatal(err)
	}
}

func TestNativeCatalogMatchesSharedStatusPresentation(t *testing.T) {
	data, err := os.ReadFile("../../contracts/setup/presentation/status-reasons.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract presentationContract
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.Schema != "murmur.status-presentation/1" || contract.Exposure.PairingPattern != peerPairingMissing.String() || len(contract.Exposure.DisplayedAllows) != 0 {
		t.Fatalf("unsupported presentation contract: %#v", contract)
	}
	for _, required := range []string{"agentId", "peerId", "fieldPath", "rawError", "missing", "missingWhy"} {
		if !containsString(contract.Exposure.Diagnostics, required) {
			t.Fatalf("presentation contract no longer retains diagnostic %q", required)
		}
	}
	for key, text := range contract.Messages {
		for _, locale := range []string{localeEnglish, localeRussian} {
			if got := catalogs[locale][key]; got != text[locale] {
				t.Errorf("catalog %s %s = %q, contract = %q", locale, key, got, text[locale])
			}
		}
	}
	for _, rule := range contract.Rules {
		missing := []string(nil)
		switch rule.Missing {
		case "only-peer-pairing-fields":
			missing = []string{"peers.list.hostile-peer.paired"}
		case "any-other-fields":
			missing = []string{"outbox.queue.failed"}
		}
		for _, code := range rule.Codes {
			if got := presentationMessageKey(code, missing); got != rule.MessageID {
				t.Errorf("presentation rule %s/%s = %q, contract = %q", code, rule.Missing, got, rule.MessageID)
			}
		}
	}
}

func TestSharedStatusPresentationFixtures(t *testing.T) {
	previous := currentLocale()
	t.Cleanup(func() { setLocale(previous) })
	data, err := os.ReadFile("../../contracts/setup/presentation/status-reasons-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures presentationFixtures
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	if fixtures.Schema != "murmur.status-presentation-fixtures/1" {
		t.Fatalf("unsupported fixture schema %q", fixtures.Schema)
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			s := load(t, filepath.Base(fixture.StatusFixture))
			verdict := resolve(s, nil)
			if verdict.Code != fixture.ExpectedCode || presentationMessageKey(verdict.Code, verdict.Missing) != fixture.ExpectedMessageID {
				t.Fatalf("presentation = code %q key %q", verdict.Code, presentationMessageKey(verdict.Code, verdict.Missing))
			}
			for _, locale := range []string{localeEnglish, localeRussian} {
				setLocale(locale)
				localized := resolve(s, nil)
				if localized.Reason != catalogs[locale][fixture.ExpectedMessageID] {
					t.Errorf("%s reason = %q, want canonical %q", locale, localized.Reason, catalogs[locale][fixture.ExpectedMessageID])
				}
				for _, forbidden := range fixture.Forbidden {
					if strings.Contains(localized.Reason, forbidden) {
						t.Errorf("%s displayed reason exposed %q: %q", locale, forbidden, localized.Reason)
					}
				}
			}
			for _, required := range fixture.RequiredMissingPaths {
				if !containsString(verdict.Missing, required) {
					t.Errorf("diagnostics lost %q: %v", required, verdict.Missing)
				}
			}
		})
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
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

func TestGuidePreferencePreservesExplicitLocale(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prefs", "tray-preferences.json")
	if guideSeenPreference(path) {
		t.Fatal("missing preferences marked the guide as seen")
	}
	if err := saveLocalePreference(path, localeRussian); err != nil {
		t.Fatal(err)
	}
	if err := saveGuideSeenPreference(path); err != nil {
		t.Fatal(err)
	}
	if !guideSeenPreference(path) || loadLocalePreference(path) != localeRussian {
		t.Fatalf("guide/locale preference was not preserved: %#v", loadTrayPreferences(path))
	}
	if err := saveLocalePreference(path, localeEnglish); err != nil {
		t.Fatal(err)
	}
	if !guideSeenPreference(path) || loadLocalePreference(path) != localeEnglish {
		t.Fatalf("locale update erased guide state: %#v", loadTrayPreferences(path))
	}
}

func TestHumanStatusTextDoesNotExposeIdentifiersOrFieldPaths(t *testing.T) {
	previous := currentLocale()
	t.Cleanup(func() { setLocale(previous) })
	setLocale(localeEnglish)
	s := &Status{}
	total := 1
	s.Inbox.Total = &total
	s.Deliveries = []Delivery{{Peer: "secret-peer-id", Direction: "inbound", At: "2026-09-20T10:00:00Z"}}
	lines := recentLinesForStatus(s)
	if len(lines) != 1 || strings.Contains(lines[0], "secret-peer-id") {
		t.Fatalf("recent menu exposed peer identity: %q", lines)
	}
	d := &Doctor{Stages: []DoctorStage{{ID: "broker", State: "fail", Detail: "token path C:\\private\\token"}}}
	if label := stageLabel(d, "broker"); strings.Contains(label, "private") {
		t.Fatalf("doctor menu exposed technical detail: %q", label)
	}
	failed := load(t, "status-green.json")
	raw := "delivery to secret-peer-id failed at outbox.queue.pending"
	failed.Wake.Faults.LastFault = &raw
	failed.Wake.Faults.LastFaultAt = &failed.GeneratedAt
	verdict := resolve(failed, nil)
	if strings.Contains(verdict.Reason, "secret-peer-id") || strings.Contains(strings.Join(verdict.History, "\n"), "secret-peer-id") {
		t.Fatalf("status menu exposed raw failure detail: reason=%q history=%q", verdict.Reason, verdict.History)
	}
	diagnostics, err := json.Marshal(failed)
	if err != nil || !strings.Contains(string(diagnostics), raw) {
		t.Fatalf("diagnostics lost raw failure: %v %s", err, diagnostics)
	}
}

func TestExplicitLocaleArgumentsAreBounded(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	got, err := parseTrayArguments([]string{"--check-profile", "--lang", "ru"})
	if err != nil || got.mode != "--check-profile" || got.locale != localeRussian || !got.localeExplicit {
		t.Fatalf("explicit locale = %#v, %v", got, err)
	}
	launched, err := parseTrayArguments([]string{"--launcher-start", "--lang", "en"})
	if err != nil || !launched.launcherStart || launched.mode != "" {
		t.Fatalf("launcher child arguments = %#v, %v", launched, err)
	}
	direct, err := parseTrayArguments(nil)
	if err != nil || direct.launcherStart {
		t.Fatalf("direct start was mistaken for launcher start: %#v, %v", direct, err)
	}
	for _, args := range [][]string{{"--lang", "de"}, {"--lang"}, {"--check-profile", "--launch"}, {"--wat"}} {
		if _, err := parseTrayArguments(args); err == nil || strings.TrimSpace(err.Error()) == "" {
			t.Fatalf("accepted invalid arguments %q", args)
		}
	}
}

func TestLocalizedErrorPreservesCause(t *testing.T) {
	cause := errors.New("sentinel")
	err := trError("binding.cliFailed", cause, cause)
	if !errors.Is(err, cause) {
		t.Fatalf("localized error lost its cause: %v", err)
	}
	var localized *localizedError
	if !errors.As(err, &localized) || localized.cause != cause {
		t.Fatalf("localized error cannot be inspected: %#v", err)
	}
}

func TestUnobservedInboxAndHostileTimeRemainVisibleAndSafe(t *testing.T) {
	previous := currentLocale()
	t.Cleanup(func() { setLocale(previous) })
	for _, locale := range []string{localeEnglish, localeRussian} {
		setLocale(locale)
		for _, status := range []*Status{nil, {}} {
			lines := recentLinesForStatus(status)
			if len(lines) != 1 || lines[0] != tr("recent.unavailable") {
				t.Fatalf("unobserved inbox disappeared: %q", lines)
			}
		}
		zero := 0
		empty := &Status{}
		empty.Inbox.Total = &zero
		if lines := recentLinesForStatus(empty); len(lines) != 1 || lines[0] != tr("recent.none") {
			t.Fatalf("measured empty inbox: %q", lines)
		}
		invalidTime := load(t, "status-green.json")
		invalidTime.GeneratedAt = "private-agent / profile.token\r\nInjected"
		if reason := resolve(invalidTime, nil).Reason; strings.Contains(reason, "private-agent") || strings.Contains(reason, "profile.token") {
			t.Fatalf("malformed snapshot time exposed: %q", reason)
		}
		hostile := &Status{Deliveries: []Delivery{{Direction: "inbound", Peer: "private-agent", At: "peers.list.private-agent.paired"}}}
		for _, line := range recentLinesForStatus(hostile) {
			if strings.Contains(line, "private-agent") || strings.Contains(line, "peers.list") {
				t.Fatalf("raw time exposed: %q", line)
			}
		}
	}
}
