package main

import (
	"encoding/json"
	"io"
)

var (
	releaseVersion = "development"
	releaseCommit  = "unknown"
)

type nativeVersion struct {
	Schema       string `json:"schema"`
	Product      string `json:"product"`
	Component    string `json:"component"`
	Version      string `json:"version"`
	SourceCommit string `json:"sourceCommit"`
}

func nativeVersionRequested(args []string) bool {
	return len(args) == 1 && args[0] == "--version"
}

func writeNativeVersion(w io.Writer) error {
	return json.NewEncoder(w).Encode(nativeVersion{
		Schema:       "murmur.native-version/1",
		Product:      "Murmur",
		Component:    "windows-service",
		Version:      releaseVersion,
		SourceCommit: releaseCommit,
	})
}
