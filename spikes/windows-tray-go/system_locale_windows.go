//go:build windows

package main

import "golang.org/x/sys/windows"

var userUILanguage = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage")

func platformLocale() string {
	language, _, _ := userUILanguage.Call()
	if language&0x3ff == 0x19 {
		return localeRussian
	}
	return localeEnglish
}
