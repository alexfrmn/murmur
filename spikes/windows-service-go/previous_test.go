package main

import "testing"

// A Service of another Murmur installation is recognised by its registration alone; anything
// else under the bound name must stay "not Murmur" so that it is never stopped or removed.
func TestPreviousInstallationImageIsRecognisedOnlyByMurmurRegistration(t *testing.T) {
	const name = "MurmurDaemon"
	for _, args := range [][]string{
		{`C:\Users\misha\Downloads\murmur-pilot\runtime\bin\murmur-svc.exe`, "run", name},
		{`C:\Program Files\Murmur 2.11\runtime\bin\MURMUR-SVC.EXE`, "run", name},
		{`D:/murmur/spikes/windows-service-go/murmur-svc.exe`, "run", name},
		{`\\fileserver\apps\murmur\murmur-svc.exe`, "run", name},
	} {
		if !previousInstallationImage(args, name) {
			t.Errorf("did not recognise previous Murmur registration %q", args)
		}
	}
	for _, args := range [][]string{
		nil,
		{`C:\Windows\System32\svchost.exe`, "-k", "netsvcs"},
		{`C:\Program Files\Other\other.exe`, "run", name},
		{`C:\Program Files\Other\murmur-svc.exe.bak`, "run", name},
		{`C:\Program Files\Other\not-murmur-svc.exe`, "run", name},
		{`murmur-svc.exe`, "run", name},
		{`bin\murmur-svc.exe`, "run", name},
		{`\\murmur-svc.exe`, "run", name},
		{`C:\murmur\murmur-svc.exe`, "run", "OtherName"},
		{`C:\murmur\murmur-svc.exe`, "run", "murmurdaemon"},
		{`C:\murmur\murmur-svc.exe`, "status", name},
		{`C:\murmur\murmur-svc.exe`, "run", name, "--lang", "ru"},
		{`C:\murmur\murmur-svc.exe`, "run"},
	} {
		if previousInstallationImage(args, name) {
			t.Errorf("treated %q as a previous Murmur registration", args)
		}
	}
}
