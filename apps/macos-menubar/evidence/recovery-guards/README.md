# Recovery guard and setup errors — native component evidence

Before: `aed842d1e442fd1499c5b7a184f774636103b8e3`. After: this PR's head.
macOS 26.6.2 arm64, Swift 6.4. EN and RU use the same native views and resources.

`render.swift` links the production model/views and `MurmurTrayCore`, excluding
`DesktopEntry.swift`. For capture only, a private source copy changes the
`firstRun` accessor from private to internal; no UI logic is changed. Arguments:
`<temporary-root> <en|ru> <before|after>`. HOME and CFFIXED_USER_HOME both point to
`<temporary-root>/home`; inherited MURMUR/NATS/profile overrides are cleared.
`MURMUR_BIN` explicitly selects the verified CLI from `4772afa`.

- Recovery captures render the real `firstRun` view with a bound test Identity
  and unavailable status. The harness invokes `beginInviting`: the baseline
  opens a new-Identity form; the fixed version refuses it.
- Access-file captures render `CreateProfileSheet` with the actual model error
  from a multiline disposable access file sent to the real CLI. They show the
  error-bearing component, not a button-click walkthrough. No Server is contacted.
- Doctor captures compare the real `DoctorSnapshot.rows()` output with pairing
  labels in a small native comparison view. The 42 ms measurement is a fixture.

No Invitation, credential or absolute local path is displayed. All profiles,
access files and preferences belong to temporary homes and are removed after
capture. Private raw logs are kept outside git; the committed summary uses
relative paths only. The older init-error captures in `../pair-by-lines/` were
replaced with the same path-free component approach.

**GUI-шаг не прогнан, заблокирован Accessibility.** `humanGuiPass mac = false`.
No Automation/Accessibility permissions were requested or changed. No live
profile, LaunchAgent, installed app or broker was changed.
