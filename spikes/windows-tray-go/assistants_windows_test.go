//go:build windows

package main

import "testing"

func TestAssistantProfileLexicalNormalization(t *testing.T) {
	if !sameAssistantProfile(`E:/temporary/Identity name`, `E:\temporary\Identity name`) {
		t.Fatal("engine slash normalization rejected")
	}
	for _, other := range []string{`E:\temporary\other`, `F:\temporary\Identity name`, `relative\Identity name`, `E:\alias\Identity name`} {
		if sameAssistantProfile(`E:\temporary\Identity name`, other) {
			t.Fatalf("different selection accepted: %s", other)
		}
	}
}
