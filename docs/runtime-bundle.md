# Prebuilt runtime bundle

The runtime ZIP removes `npm ci`, TypeScript and Git from the recipient's setup.
It includes the CLI, daemon, MCP server and their locked JavaScript dependencies.
Node.js 22.13.0 or newer remains an external prerequisite. The native tray and
Windows service executable are separate artifacts; this ZIP alone is not a
complete graphical installer.

## Build from one commit

On a Linux release builder with Git, tar, npm and the supported Node version:

```sh
node scripts/build-runtime-bundle.mjs --ref HEAD --out /absolute/new/output
```

Commit the recipe first: the running builder must match the selected commit.
The builder exports that commit into an empty temporary directory, runs
`npm ci --ignore-scripts` and `npm run build`, then packages the selected runtime.
It never reads existing `dist` or `node_modules` from the working checkout.
Install scripts are disabled because this subset has no native addons. Building
all workspace TypeScript does not require compiling unrelated native addons.

The archive contains `runtime/`. Extract the whole directory; do not move the CLI
away from its sibling packages and scripts. In PowerShell, for example:

```powershell
Expand-Archive .\murmur-runtime-VERSION.zip -DestinationPath .\Murmur
node .\Murmur\runtime\packages\setup\bin\murmur.mjs version
```

Use the shared [onboarding commands](setup-onboarding.md) with an explicit data
directory. The runtime uses ordinary directories for workspace packages, so
extracting it on Windows does not require administrator or symlink privileges.
No dependency installation or build command is run on the recipient's machine.

## Contents and provenance

Six workspaces are included: core, security, broker-nats, broker-ws, mcp-server
and setup. Their production dependency graph is traversed recursively using the
installed lockfile layout, including nested dependencies and required peers.
The daemon's direct `ws` dependency is included. Optional native peers such as
`pg-native` and WebSocket acceleration are not required or included. Optional
package dependencies must be installed and pass the same packaging rules.

The declared pure JavaScript `pg` dependency is preserved. Its inclusion is not
Postgres acceptance evidence; release acceptance currently exercises SQLite.
A2A, observability, unrelated bridges and `better-sqlite3` are not included.
No `.node` addon, symlink, TypeScript build cache or Python bytecode is allowed.

`runtime-manifest.json` records the exact source commit, declared product version,
source lockfile hash, recipe hash, build Node version, dependency versions and
integrities, and SHA256/size of every payload file. The manifest excludes itself;
`SHA256SUMS.txt` covers the ZIP, which contains the manifest. Both are build
outputs, not cryptographic publisher signatures. Verify the distributed checksum
through the trusted release channel. A declared version alone does not prove
source identity: an unreleased snapshot must not be uploaded as a new build of
an old release without a new version and release notes.

ZIP entry order and timestamps are fixed. Repacking unchanged staged bytes with
the same Node/zlib version produces the same ZIP. This is not a claim that every
Node/compiler/platform combination produces identical build output. File modes
are normalized to regular 0644 or executable 0755. Each dependency retains its
published license files; the root MIT license is included.

## Verification boundaries

Unit checks stage and invoke the real CLI outside the checkout, exercise missing
build output and symlink rejection, and compare two ZIP byte streams. CI also
builds from the selected Git commit and extracts that ZIP on Windows using
`Expand-Archive`, then runs the CLI and MCP handshake with external Node.

A release additionally needs a returned message through real daemons and MCP
servers on the target OS, checked from the actual distributed artifact. A CLI
version response or successful extraction does not establish service installation,
tray discovery, startup after login/reboot, live LLM wake, GUI operation or OS
signature trust. These acceptance results must be recorded separately.
