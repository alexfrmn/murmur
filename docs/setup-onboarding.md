# Source-checkout onboarding CLI

Build the checkout with `npm ci` and `npm run build`. Invoke the same executable
from PowerShell, Bash or another shell: `node packages/setup/bin/murmur.mjs`.
No environment assignment syntax is required. Every profile-specific command
accepts `--data-dir ABSOLUTE_PATH`; the service, daemon and MCP entry use this one
profile. This is a source-checkout workflow, not a published npm installation.

1. `init --agent-id ID --broker-url URL [private broker file options]` creates a
   private identity. Repeating it with the same ID and broker preserves the keys
   and credentials. It never rotates an existing broker credential. Conflicting
   existing identity, endpoint, or explicitly supplied credential is rejected.
2. `invite --out ABSOLUTE_FILE` writes a new private invitation file. It contains
   public peer keys and the broker address. New v1 invitations never contain the
   sender's broker token, username, password, or TLS file paths. Transfer the file
   through a trusted channel. Credentials are not printed in the command result or
   passed as literal command arguments. An existing output file is never overwritten. Invitation and reply outputs must
   have an already-existing parent and be outside the managed data directory, including
   symlink and filesystem case aliases; a reply path
   must never name a private config, database, cursor or future runtime state file.
3. On the other machine, `join --agent-id ID --invite-file ABSOLUTE_FILE --reply-out
   ABSOLUTE_FILE [private broker file options]` imports the invitation and creates a
   private public-key reply. Each recipient supplies its own local broker credential.
4. On the first machine, `add-peer --reply-file ABSOLUTE_FILE` completes key import.
   It refuses silent key replacement, saves a private configuration backup and
   clears only that peer's poisoned dedupe entries. Failure reading the store is
   reported as an unknown reset result, never zero.
5. `clients detect` reports verified client/profile paths. `clients configure
   --client ID` updates only the Murmur MCP entry in that selected JSON or TOML
   profile. A conflicting entry requires explicit `--replace`. Existing contents
   are backed up byte-for-byte in a private file; unrelated settings, including
   Codex ChatGPT authentication settings, survive a semantic parse/serialize check.
   Formatting and TOML comments may be normalized; the original remains in backup.
6. `service install`, `service start`, then `doctor --peer ID --json` checks the
   actual running installation. Client reload is required after MCP configuration.
   No client executable is invoked to change authentication or discover settings.

Key import returns `paired: null`: local keys are not evidence of two-way reachability.
Doctor subscribes only to the selected profile's actual receive subjects, sends a
nonce through the real daemon outbox, verifies the peer's signed encrypted reply,
and requires that reply in the local inbox before saving pairing evidence.
It does not certify GUI appearance or an LLM session wake.

## TLS and broker credentials

Use `tls://` for every non-loopback broker. Plaintext `nats://` is accepted only
for loopback development. Setup uses the same secure connection builder as the
daemon and rejects URL userinfo, query strings, fragments, mixed token/user auth,
and an IP TLS endpoint without an explicit certificate DNS name.

Provide exactly one authentication form: `--token-file ABSOLUTE_FILE`, or
`--user-file ABSOLUTE_FILE --password-file ABSOLUTE_FILE`. Secret files must be
owned by the current user and private on POSIX. They may have one final newline;
embedded newlines and empty values are rejected. For a private CA add
`--ca-file ABSOLUTE_FILE`. When the URL uses an IP address, add
`--server-name broker.example` matching the certificate. These options apply to
both `init` and `join`; only paths appear in the process arguments.
Doctor reopens referenced CA/certificate/key files with bounded no-follow reads
before connecting. It requires regular owned files and private permissions for a
client key on POSIX. These checks establish the path state at that instant; they
do not pin a same-user editable path for the lifetime of the connection.

Compatibility import accepts the old v1 `natsToken` invite field only. The join
receipt then reports `legacyCredentialImported: true`; newly generated invites
remain credential-free. Any other top-level or nested invite/reply field is
rejected rather than treated as a future credential shape.

## Migrating an existing broker

An old profile using remote plaintext can be read only by the migration command;
normal status, doctor, and daemon-facing setup reads reject it. Stop the managed
Murmur service, then preview the change:

```text
node packages/setup/bin/murmur.mjs broker migrate --data-dir ABSOLUTE_PROFILE --broker-url tls://broker.example:4222 --user-file ABSOLUTE_USER_FILE --password-file ABSOLUTE_PASSWORD_FILE --ca-file ABSOLUTE_CA_FILE --json
```

The preview does not write state or report credential values. It identifies only
the endpoint scheme and redacted authentication kind (`none`, `token`, or
`user-password`). Repeat with `--apply` to write an atomic private config plus a
byte-exact private backup of the reviewed config. The migration
changes only `natsUrl`, `natsToken`, `natsUser`, `natsPassword`, and `natsTls`;
identity keys, peers, wake settings, custom keys, database history, and cursors are
preserved. Applying an unchanged target is a no-op. Restart the service explicitly
after a successful apply, then run `doctor --peer ID --json`.

Apply also requires a platform profile-usage probe to report this exact profile
free. A stopped or absent managed service does not prove that a standalone daemon
has released it. If the platform cannot inspect profile use, migration fails with
`migration.profile-usage-unavailable` and leaves the config unchanged. The probe
and daemon-observation checks are repeated under the setup write lock immediately
before mutation; they are point-in-time evidence rather than a lifetime lock.

Linux/systemd, Darwin/launchd and Windows SCM adapters use the shared CLI.
Windows additionally needs the matching native service helper and elevation for
service mutations; see [Windows CLI](windows-service-cli.md). An already-running service must be restarted explicitly to load
changed peer configuration. Commands do not silently stop running processes.
