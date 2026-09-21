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

1. `init --agent-id ID --broker-url URL [--token-file ABSOLUTE_FILE]` creates a
   private identity. Repeating it with the same ID and broker preserves the keys
   and credentials. Conflicting existing identity is rejected.
2. `invite --out ABSOLUTE_FILE` writes a new private invitation file. It contains
   public peer keys and may contain the broker token; transfer it through a trusted
   channel. Credentials are not printed in the command result or passed as token
   arguments. An existing output file is never overwritten. Invitation and reply outputs must
   have an already-existing parent and be outside the managed data directory, including
   symlink and filesystem case aliases; a reply path
   must never name a private config, database, cursor or future runtime state file.
3. On the other machine, `join --agent-id ID --invite-file ABSOLUTE_FILE --reply-out
   ABSOLUTE_FILE` imports the invitation and creates a private public-key reply.
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

To check a selected AI client's real exchange, `reply-test prepare --peer ID`
returns a request, conversation ID and a 15-minute test token without sending
anything. Send the returned request through that client's Murmur tools, using
the returned conversation. `reply-test check --test-token TOKEN` reads the
matching durable request and reply without consuming the inbox. Keep the request
and expected reply as exact standalone lines; an agent introduction or signature
may appear on separate lines. A blockquoted marker or marker embedded in another
sentence does not count. Success confirms the exchange, not autonomous wake.

Linux/systemd, Darwin/launchd and Windows SCM adapters use the shared CLI.
Windows additionally needs the matching native service helper and elevation for
service mutations; see [Windows CLI](windows-service-cli.md). An already-running service must be restarted explicitly to load
changed peer configuration. Commands do not silently stop running processes.
