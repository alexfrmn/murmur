package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestNativeVersionIsPureAndMachineReadable(t *testing.T) {
	if !nativeVersionRequested([]string{"--version"}) {
		t.Fatal("exact --version flag was not recognized")
	}
	for _, args := range [][]string{nil, {"--version", "extra"}, {"--lang", "ru", "--version"}} {
		if nativeVersionRequested(args) {
			t.Fatalf("accepted non-exact version request %q", args)
		}
	}
	var output bytes.Buffer
	if err := writeNativeVersion(&output); err != nil {
		t.Fatal(err)
	}
	var got nativeVersion
	if err := json.Unmarshal(output.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := nativeVersion{
		Schema:       "murmur.native-version/1",
		Product:      "Murmur",
		Component:    "windows-tray",
		Version:      releaseVersion,
		SourceCommit: releaseCommit,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("version output = %#v, want %#v", got, want)
	}
}
