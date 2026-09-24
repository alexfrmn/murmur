package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestNativeLogResponseRefusesOtherIdentityPathAndSource(t *testing.T) {
	b := cliBinding{Profile: t.TempDir(), Service: "murmur-fixture"}
	logDir := filepath.Join(t.TempDir(), "logs")
	valid := map[string]string{"schema": "murmur.logs/1", "agentId": "fixture", "dataDir": b.Profile, "serviceName": b.Service, "source": "native", "logDir": logDir}
	bytes, _ := json.Marshal(valid)
	if got, err := parseNativeLogDirectory(bytes, b, "fixture"); err != nil || got != logDir {
		t.Fatalf("%s: %v", got, err)
	}
	for key, value := range map[string]string{"schema": "murmur.logs/2", "agentId": "other", "dataDir": t.TempDir(), "serviceName": "other", "source": "configured", "logDir": "relative"} {
		t.Run(key, func(t *testing.T) {
			bad := map[string]string{}
			for k, v := range valid {
				bad[k] = v
			}
			bad[key] = value
			bytes, _ := json.Marshal(bad)
			if _, err := parseNativeLogDirectory(bytes, b, "fixture"); err == nil {
				t.Fatal("unbound log response accepted")
			}
		})
	}
}
