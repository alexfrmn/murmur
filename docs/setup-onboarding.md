# Source-checkout onboarding CLI

Build the checkout with `npm ci` and `npm run build`. Invoke the same executable
from PowerShell, Bash or another shell: `node packages/setup/bin/murmur.mjs`.
No environment assignment syntax is required. Every profile-specific command
accepts `--data-dir ABSOLUTE_PATH`; the service, daemon and MCP entry use this one
profile. This is a source-checkout workflow, not a published npm installation.

The older `scripts/murmur-invite.mjs`, `scripts/murmur-join.mjs` and
`scripts/murmur-add-peer.mjs` entrypoints are disabled compatibility notices.
They exit without reading or changing a profile and name the equivalent command
below. Invitation and reply material stays in private files instead of terminal
output and shell arguments.

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
`user-password`). A successful preview does not mean apply will succeed: it
validates the proposed configuration, but does not check whether the service or
other processes are using the profile. Apply checks that live state immediately
before writing and refuses if it cannot verify it. Repeat with `--apply` to write
an atomic private config plus a byte-exact private backup of the reviewed config. The migration
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

`migration.runtime-unverifiable` means the saved daemon observation could not be
read, did not identify this profile, or its recorded process could not be
checked. The config remains unchanged. Check that you selected the intended
profile, then inspect its `daemon-observation.json` and the recorded process
state without editing either. Stop a confirmed service or standalone daemon
through its normal controls. If the observation cannot be reconciled with the
profile, keep the files and request diagnosis; deleting the observation or
recreating the profile is not a migration step.

Unix probes include visible processes belonging to other users, including root;
private profile permissions do not exclude privileged holders. Missing process
coverage, inaccessible file descriptors, process churn or truncated output leave
usage unknown. Ordinary macOS/Linux accounts may therefore be unable to migrate
an existing profile with this build. Keep the existing profile and configuration
in that case; there is no forced apply or confirmation switch. Closing the tray
icon does not stop the service or MCP processes inside configured clients. A
supported privileged probe or a separate migration procedure is needed before
that restriction can be lifted.

### Profile path aliases

On macOS and Linux, `migration.profile-path-aliased` means that the selected
path resolves through a filesystem alias, including a parent-directory link.
Both preview and apply stop before changing files or inspecting the service.
Print the canonical path without changing the profile:

```sh
node -e "console.log(require('node:fs').realpathSync(process.argv[1]))" '/absolute/path/to/selected/profile'
```

Use that output as `--data-dir` and preview again. The default service name is
derived from the supplied path. If the existing service was registered through
an alias, retain its known name with `--service-name EXISTING_SERVICE_NAME` in
the migration command; do not install a second service. If its name is unknown,
identify it from the existing service registration before applying. Resolving
the path does not establish that the profile is free: all usage checks still
apply. No identity or profile recreation is required.

### Files with more than one name

`migration.profile-hard-linked` means a regular file in the selected profile has
more than one hard-link name. All those names refer to the same file contents;
renaming or deleting one name does not remove the others. Normal filesystem
permissions still apply. Migration leaves the profile unchanged.

First list affected files without reading their contents (macOS or Linux):

```sh
find '/absolute/path/to/selected/profile' -type f -links +1 -print
```

To find the other names, use `ls -li` on an affected file to obtain its inode,
then `find '/known/folder/on/the/same/volume' -xdev -inum INODE_NUMBER -print`.
Start with folders where you created copies or links. A permission error or an
incomplete search does not prove that no other name exists. Ask the system
administrator to inspect inaccessible locations if necessary.

After confirming which names and files you own, remove only an unintended link,
keeping the intended profile file. Do not delete the profile, regenerate its
identity, or remove a link whose purpose is unknown. Repeat the first inspection,
then retry migration. If both names are intentional, keep them and leave
migration unapplied until you have a plan for separating those files safely.

Linux/systemd, Darwin/launchd and Windows SCM adapters use the shared CLI.
Windows additionally needs the matching native service helper and elevation for
service mutations; see [Windows CLI](windows-service-cli.md). An already-running service must be restarted explicitly to load
changed peer configuration. Commands do not silently stop running processes.
