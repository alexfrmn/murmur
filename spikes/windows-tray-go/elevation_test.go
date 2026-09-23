package main

import "testing"

func TestElevatedCommandLineSurvivesWindowsArgumentSplitting(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`plain`, `plain`},
		{``, `""`},
		{`C:\Users\Имя Фамилия\AppData\Local\Murmur`, `"C:\Users\Имя Фамилия\AppData\Local\Murmur"`},
		{`C:\path with space\`, `"C:\path with space\\"`},
		{`say "hi"`, `"say \"hi\""`},
		{`a\"b c`, `"a\\\"b c"`},
		{`C:\no\spaces\murmur.mjs`, `C:\no\spaces\murmur.mjs`},
	} {
		if got := quoteWindowsArg(c.in); got != c.want {
			t.Errorf("quote(%q) = %s, want %s", c.in, got, c.want)
		}
	}
	got := elevatedCommandLine([]string{`C:\Мурмур 2.11\runtime\packages\setup\bin\murmur.mjs`, "service", "start", "--json", "--data-dir", `C:\Users\me\Murmur`, "--service-name", "MurmurDaemon"})
	want := `"C:\Мурмур 2.11\runtime\packages\setup\bin\murmur.mjs" service start --json --data-dir C:\Users\me\Murmur --service-name MurmurDaemon`
	if got != want {
		t.Fatalf("command line\n got %s\nwant %s", got, want)
	}
}
