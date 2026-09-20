package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type cliBinding struct{ Node, Entry, Profile, Service string }

func selectedCLI() (cliBinding, error) {
	b := cliBinding{os.Getenv("MURMUR_BIN"), os.Getenv("MURMUR_CLI"), os.Getenv("MURMUR_PROFILE"), os.Getenv("MURMUR_SERVICE_NAME")}
	for _, p := range []string{b.Node, b.Entry, b.Profile} {
		if !filepath.IsAbs(p) || strings.ContainsAny(p, "\x00\r\n") {
			return b, errors.New(tr("binding.select"))
		}
	}
	for _, p := range []string{b.Node, b.Entry} {
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			return b, errors.New(tr("binding.moved"))
		}
	}
	if b.Service != "" && !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$`).MatchString(b.Service) {
		return b, errors.New(tr("binding.invalidService"))
	}
	return b, nil
}
func (b cliBinding) arguments(args []string) []string {
	result := append([]string{b.Entry}, args...)
	result = append(result, "--data-dir", b.Profile)
	if b.Service != "" {
		result = append(result, "--service-name", b.Service)
	}
	return result
}
func (b cliBinding) environment() []string {
	allowed := map[string]bool{"systemroot": true, "windir": true, "programdata": true, "userprofile": true, "localappdata": true, "appdata": true, "temp": true, "tmp": true, "path": true, "home": true}
	result := []string{}
	for _, value := range os.Environ() {
		key, _, ok := strings.Cut(value, "=")
		if ok && allowed[strings.ToLower(key)] {
			result = append(result, value)
		}
	}
	result = append(result, "DATA_DIR="+b.Profile, "MURMUR_DATA_DIR="+b.Profile)
	if os.Getenv("MURMUR_UPDATE_CHECK") == "0" {
		result = append(result, "MURMUR_UPDATE_CHECK=0")
	}
	return result
}

type boundedOutput struct {
	bytes.Buffer
	exceeded bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := 256*1024 - b.Len()
	if n > left {
		b.exceeded = true
		p = p[:left]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}
func invokeCLI(ctx context.Context, args ...string) ([]byte, error) {
	b, err := selectedCLI()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, b.Node, b.arguments(args)...)
	cmd.Env = b.environment()
	cmd.Dir = filepath.Dir(b.Entry)
	hideConsole(cmd)
	var stdout, stderr boundedOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if stdout.exceeded || stderr.exceeded {
		return nil, errors.New(tr("binding.outputLarge"))
	}
	if err != nil {
		return nil, trError("binding.cliFailed", err, err)
	}
	return stdout.Bytes(), nil
}

// A fresh status may describe another identity after an external profile change.
// Never publish it as the previously selected agent or use it for mutation.
func validatePinnedStatus(s *Status, expected string) error {
	if s == nil || !schemaKnown(s.Schema, statusSchema) || s.AgentID == "" {
		return errors.New(tr("binding.identityUnconfirmed"))
	}
	age, ok := ageOf(s.GeneratedAt)
	if !ok || age > maxStatusAge || age < -clockSkewTolerance {
		return errors.New(tr("binding.statusAge"))
	}
	if expected != "" && s.AgentID != expected {
		return errors.New(tr("binding.identityChanged"))
	}
	return nil
}
func validateAction(buf []byte, command, action string) error {
	var v map[string]any
	if err := json.Unmarshal(buf, &v); err != nil {
		return err
	}
	if command == "service" && v["schema"] == "murmur.service/1" && v["action"] == action {
		return nil
	}
	if command == "wake" && v["schema"] == "murmur.wake/1" && v["configuredEnabled"] == (action == "resume") {
		return nil
	}
	return errors.New(tr("binding.actionUnconfirmed"))
}

var mutationTimeout = 60 * time.Second
