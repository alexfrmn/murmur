//go:build !windows

package main

import (
	"context"
	"os/exec"
)

func hideConsole(cmd *exec.Cmd) {}

func serviceAdmin() bool { return false }

func runElevated(context.Context, string, []string, string) error { return errElevationCancelled }
