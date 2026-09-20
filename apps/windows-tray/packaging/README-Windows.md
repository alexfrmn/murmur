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

The tray is English on a fresh profile regardless of the Windows display language. Use
`-Language ru` to open it in Russian; `-Language en` switches back to English. The
choice is saved in `%LOCALAPPDATA%\Murmur\tray-preferences.json`, reused when
`-Language` is omitted, and can also be changed from the tray's **Language** menu.

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

## Release bundle recipe

Maintainers build the complete companion on Windows from one committed Git ref:

```powershell
node scripts/build-windows-bundle.mjs --ref HEAD --out C:\absolute\new-output
```

The producer needs Git, Node.js 22.13.0 or newer with its adjacent `npm-cli.js`,
tar, and Go 1.24. The
recipient does not need Git, npm, Go, or a compiler. The recipe exports a clean
Git archive, installs its locked build dependencies outside the payload, builds
the portable runtime, and cross-checks its root product version with the lockfile.
It then builds both Windows executables with `GOOS=windows`, `GOARCH=amd64`,
`CGO_ENABLED=0`, `-trimpath`, and linker values for the exact version and commit.
Each executable's `--version` JSON is executed on the producer before packaging.

The new output directory contains `Murmur-Windows-VERSION-x64.zip`, the matching
`release-manifest.json`, and `SHA256SUMS.txt`. The ZIP has this extraction layout:

```text
Open-Murmur.cmd
Open-Murmur.ps1
README-Windows.md
check-windows-bundle.mjs
murmur-tray.exe
release-manifest.json
runtime/
  runtime-manifest.json
  bin/murmur-svc.exe
  ...portable engine...
```

The release manifest records the exact 40-character source commit, declared
product version, release-recipe hash, checker hash, runtime-recipe hash, native component
declarations, and SHA-256 plus byte size for every payload file except the
manifest itself. It also records the Node and Go producer versions. The runtime
manifest independently inventories the portable
engine before the service executable is added. Both recipes reject existing
outputs and symbolic links; only the explicit launcher, documentation, native
binaries, and staged runtime enter the ZIP. User profiles, `.data` directories,
private configuration, source dependencies, and compiler caches are not copied.

After extraction, verify both inventory layers with:

```powershell
node .\check-windows-bundle.mjs .
```

On Windows the checker also executes both native `--version` contracts. The
recipe fixes the source graph and records its provenance; it does not promise
bit-identical executables across different Node or Go toolchain versions.

These unsigned Go executables expose precise version and source-commit metadata
through `--version` and the release manifest. This recipe does not add Windows
Explorer `VERSIONINFO`; the absence of Explorer file properties is not evidence
that the binary is unversioned or signed.
