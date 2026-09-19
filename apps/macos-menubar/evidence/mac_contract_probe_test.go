package main

import (
    "encoding/json"
    "os"
    "testing"
    "time"
)

// Independent Mac review probes; not a modification of the owner's branch.
func TestMacReviewContractMustFailClosed(t *testing.T) {
    cases := []struct{name string; change func(map[string]any)}{
        {"invalid-generatedAt", func(v map[string]any) { v["generatedAt"] = "not-a-date" }},
        {"missing-generatedAt", func(v map[string]any) { delete(v,"generatedAt") }},
        {"unknown-service-state", func(v map[string]any) { v["service"].(map[string]any)["state"] = "surprise" }},
        {"missing-required-wake", func(v map[string]any) { delete(v,"wake") }},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            raw, err := os.ReadFile("fixtures/status-green.json"); if err != nil { t.Fatal(err) }
            var object map[string]any
            if err := json.Unmarshal(raw, &object); err != nil { t.Fatal(err) }
            object["generatedAt"] = time.Now().UTC().Format(time.RFC3339)
            tc.change(object)
            altered, _ := json.Marshal(object)
            var status Status
            if err := json.Unmarshal(altered, &status); err != nil { t.Fatal(err) }
            actual := resolve(&status, nil)
            if actual.Level != LevelGrey {
                t.Fatalf("expected grey for invalid contract; actual=%v reason=%s", actual.Level, actual.Reason)
            }
        })
    }
}
