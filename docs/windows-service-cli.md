# Windows CLI and the native service helper

The shared CLI uses `murmur-svc.exe` for SCM actions and observations. The helper must
implement `murmur.windows-service/1` including the selected profile and measured
restart window. Older spike executables are rejected; a successful process exit
alone does not establish a successful action.

The helper is found at `runtime/bin/murmur-svc.exe` in a Windows runtime package or
`spikes/windows-service-go/murmur-svc.exe` in a source build. `MURMUR_SERVICE_BIN`
can explicitly name an absolute helper path. The CLI does not search the current
working directory or execute a shell. Portable runtime ZIPs alone do not contain
this platform-specific binary; the Windows distribution must include it.

Node.js 22.13.0 or newer is required. No Go installation is needed when using the
prebuilt helper. Status works from an ordinary user terminal. Service mutations
require a terminal elevated as the same user; the CLI does not request elevation
or restart itself silently. Keep the same explicit profile in every command:

```powershell
$Runtime = 'C:\Murmur\runtime'
$DataDir = Join-Path $env:LOCALAPPDATA 'Murmur'
$Cli = Join-Path $Runtime 'packages\setup\bin\murmur.mjs'
node $Cli status --data-dir $DataDir --json
# Run the following in an elevated terminal with the same variable values:
node $Cli service install --data-dir $DataDir --json
node $Cli service start --data-dir $DataDir --json
node $Cli service stop --data-dir $DataDir --json
node $Cli service uninstall --data-dir $DataDir --json
```

Initialize the identity and configure peers using the normal CLI onboarding
commands before installing the service. `uninstall` removes the service and its
helper metadata, retaining the private profile and logs. It is currently supported
by the Windows adapter; other adapters return `service.uninstall-unavailable`.

The default private profile is `%LOCALAPPDATA%\Murmur`, separate from public
SCM metadata in `%ProgramData%\Murmur`. Existing profiles are not moved. For an
existing explicit profile continue passing `--data-dir`; a profile under or above
the metadata directory is rejected by the helper before ACL changes. `DATA_DIR`
is canonical, `MURMUR_DATA_DIR` is a compatibility alias; conflicting values fail.
An explicit `--data-dir` overrides both ambient variables.

The CLI pins the selected profile, runtime, Node executable and service name in
every helper call. It drops ambient Node injection and store overrides. Native
profile ownership is checked again during the mutation. This is not an atomic
transaction spanning CLI inspection and the SCM action.

The adapter passes the daemon PID, not the SCM host PID, into shared status. An
observed database path must agree with the selected profile after canonicalization.
The actual restart interval is retained; a short interval cannot become an hourly
zero. Missing helper, unavailable manager, malformed response and mismatched
profile produce unknown status with a reason. A failed action is not retried.

Client detection currently supports Claude Code and Codex CLI executables in
absolute PATH entries. Configuration uses the existing shared JSON/TOML writer;
client reload remains explicit. Desktop application discovery is not implemented.
The helper currently writes service logs below `%ProgramData%\Murmur\logs`; the
profile-contained `logs path` contract cannot represent this location and returns
`logs.windows-native-location-unavailable` instead of claiming a different folder.

Tests of the native helper, the shared CLI, a returned message, tray UI, login and
reboot are separate acceptance gates. Passing one does not imply the others.
