package main

import (
	"encoding/json"
	"errors"
	"path/filepath"
)

// The shared engine discovers and verifies the native folder. The tray binds
// that response to the selected profile before handing it to Explorer.
func parseNativeLogDirectory(out []byte, binding cliBinding, agent string) (string, error) {
	var result struct{ Schema, AgentID, DataDir, ServiceName, LogDir, Source string }
	if json.Unmarshal(out, &result) != nil || result.Schema != "murmur.logs/1" || agent == "" || result.AgentID != agent || !sameAssistantProfile(result.DataDir, binding.Profile) || result.Source != "native" || !serviceNamePattern.MatchString(result.ServiceName) || (binding.Service != "" && result.ServiceName != binding.Service) || !filepath.IsAbs(result.LogDir) {
		return "", errors.New("logs.response-invalid")
	}
	return result.LogDir, nil
}
