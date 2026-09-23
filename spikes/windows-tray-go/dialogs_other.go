//go:build !windows

package main

func fileDialog(bool, string, string) (string, bool) { return "", false }
func askYesNo(string, string) bool                   { return false }
func tell(string, string)                            {}
func revealAndCopy(string)                           {}
func desktopFolder() string                          { return "" }
func folderDialog(string) (string, bool)             { return "", false }
