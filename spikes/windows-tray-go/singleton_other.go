//go:build !windows

package main

type trayInstance struct{}

func trayInstanceKey(exe string) string       { return exe }
func claimTray(string) (*trayInstance, error) { return &trayInstance{}, nil }
func (t *trayInstance) wait() bool            { select {} }
func openOwnMenu() error                      { return nil }
