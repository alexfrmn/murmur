# Murmur CLI

Install once, join with a private invitation file, and connect an AI client to
Murmur's encrypted messaging mesh. The executable is `murmur`.

The public npm release is pending. After `@murmurv2/cli@2.11.0` is published,
use the command below. Until publication is confirmed, use a GitHub release
asset; older public registry packages do not contain the current fixes.
Maintainers rehearsing a release use only their coordinator-approved registry.

```sh
npm install --global @murmurv2/cli@2.11.0
murmur version --json
```

Node.js **22.13.0 or newer** is required. No Git, TypeScript, Go, native compiler,
install lifecycle scripts or helper download is needed on the receiving machine.
The tarball includes the CLI, daemon, MCP entry, and prebuilt Windows x64 service
helper. It does not include a desktop application. On Windows PowerShell use
`npm.cmd` and `murmur.cmd` if execution policy blocks the PowerShell shims.

Use the same absolute profile path for every command below.

To create an Invitation, use `murmur invite --out /private/invite.txt --data-dir /absolute/profile`.
If the profile uses a private Server address, ask for that Server's public address
and add `--broker nats://server.example.com:4222`. The Invitation uses this address;
the Service keeps its existing settings. A private override is also refused.

To accept an Invitation:

```sh
murmur join --agent-id YOUR-AGENT --invite-file /private/invite.txt --reply-out /private/reply.txt --data-dir /absolute/profile
murmur service install --data-dir /absolute/profile
murmur service start --data-dir /absolute/profile
murmur clients detect --data-dir /absolute/profile
murmur clients configure --client codex-cli --data-dir /absolute/profile
murmur doctor --peer HOST-AGENT --data-dir /absolute/profile --json
```

The invitation host must import your reply file and reload its own peer
configuration before the roundtrip check can succeed. Keep the invitation and
reply outside the profile, in an existing private directory. Do not paste them
into chat or edit `agent-config.json` manually.

Choose an installed client reported by `clients detect`; configuration preserves
unrelated settings and refuses conflicting Murmur entries. Reload that client,
then require a returned `murmur_request` response. A daemon ACK alone is not an
agent reply or proof that an LLM woke up.

On Windows, run **service mutations only** from an elevated terminal. The CLI and
AI client normally run without elevation. The Windows service is x64-only in
this release. On Linux the service uses user systemd; on macOS it uses launchd.
Commands do not silently restart an existing daemon or replace an occupied profile.

For an isolated install, add `--prefix /absolute/npm-prefix` to the npm command
and use its generated `bin/murmur` (Windows: `murmur.cmd` in the prefix). Keep that
prefix in place while its service and client configuration refer to it.

[`docs/setup-onboarding.md`](https://github.com/alexfrmn/murmur/blob/main/docs/setup-onboarding.md)
documents the shared commands and their evidence limits.

On Windows, `murmur logs path --data-dir <profile> --json` verifies the native
Service's profile before returning its existing readable folder under
`%ProgramData%\Murmur\logs\<service-name>`. The response uses
`murmur.logs/1` with `source: "native"`. Missing or unverified Services and folders
are refused; the command does not create directories or change the Service.
Pass the same `--service-name` used during installation when it was customized.
