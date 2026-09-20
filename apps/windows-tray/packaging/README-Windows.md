# Windows companion bundle

Keep `Open-Murmur.cmd`, `Open-Murmur.ps1`, `murmur-tray.exe` and `runtime/` together.
The runtime is the prebuilt portable engine; Windows adds its matching native
`runtime/bin/murmur-svc.exe`. Node.js 22.13.0 or newer is external. No Go/npm/build is
needed on the recipient's machine. Unsigned binaries may trigger Windows warnings.

Initialize/join and install the service through the CLI first, using one explicit
profile. Double-click `Open-Murmur.cmd`, then select that existing profile folder.
The launcher checks the local runtime and actual tray-to-CLI identity before
opening the menu. It neither creates a profile nor writes client config or login
startup. A custom service name must be supplied every time:

```powershell
.\Open-Murmur.cmd -DataDir 'C:\Users\you\AppData\Local\Murmur' -ServiceName MurmurDaemon
```

The wrapper uses a per-process PowerShell execution-policy override; it does not
change the machine policy. `-NodePath` explicitly selects another installed Node.
`-Check -DataDir ABSOLUTE` performs the read-only binding probe without opening a
window. Ordinary users can inspect status and change the configured wake pause;
SCM start/stop requires an elevated CLI terminal. The tray does not elevate itself.

The app consumes the CLI's selected profile. It pins agent identity across refresh
and before actions, checks response freshness, and discards a changed identity
until explicit app restart/reselection. It never consumes inbox unread state.
Pause/resume changes the setting without applying a service restart; configured,
effective and needs-restart are shown separately. Pending/unread remain visible.
The unsupported Windows log-path menu is disabled with a reason, without inventing
a log location. Closing the tray leaves the service running.

Debug file snapshots are accepted only when no explicit profile is bound, and
cannot authorize actions. A valid response envelope to a mutation still requires
a fresh status read; there is no atomic transaction between that read and mutation.
The native service helper separately checks profile ownership.

This wrapper is not an updater, an installer or a GUI onboarding wizard. Login,
reboot, browser warnings and actual GUI clicks have separate acceptance records.
