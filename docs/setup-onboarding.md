# Onboarding CLI

The publishable `@murmurv2/cli` package exposes the same commands as `murmur`.
During rehearsal, install only from the coordinator's explicit registry:
`npm install --global @murmurv2/cli --registry <approved-registry-url>`.
The public npm hold remains until a reviewed release is actually published.
The package contains compiled runtime files and a Windows x64 service helper;
it needs Node.js >=22.13.0 but no consumer-side compiler or install hooks.
See the [CLI package guide](../packages/setup/README.md).

Build the checkout with `npm ci` and `npm run build`. Invoke the same executable
from PowerShell, Bash or another shell: `node packages/setup/bin/murmur.mjs`.
No environment assignment syntax is required. Every profile-specific command
accepts `--data-dir ABSOLUTE_PATH`; the service, daemon and MCP entry use this one
profile. In an npm installation replace the source entry with `murmur`.

On Windows, setup protects new identity state, invitations, client configuration
and backups with a non-inheriting file ACL before writing secrets.
Only the creating account and SYSTEM (used by the native service) receive access.
File protection uses built-in Windows PowerShell without changing the parent
directory ACL; if protection cannot be applied and verified,
the write fails. Replacing an existing state or client configuration file preserves
its Windows access policy, including intentional service or sandbox readers; it
does not audit or tighten that existing policy. Its new backup is private. Preview
and unchanged client entries do not change permissions.

When `init` or `join` creates the profile directory, it first applies the same
owner-and-SYSTEM policy with the system `icacls.exe`. An existing profile directory
keeps its ACL. If protecting a newly created directory fails, setup removes the
empty directories it just created before returning the error, so a retry cannot
mistake an unprotected directory for an existing private profile.

The older `scripts/murmur-invite.mjs`, `scripts/murmur-join.mjs` and
`scripts/murmur-add-peer.mjs` entrypoints are disabled compatibility notices.
They exit without reading or changing a profile and name the equivalent command
below. The current commands support private file copies and one-line exchange
through subprocess input/output; credentials never need to be placed in shell arguments.

1. `init --agent-id ID --broker-url URL [--token-file ABSOLUTE_FILE]` creates a
   private identity. Repeating it with the same ID and broker preserves the keys
   and credentials. Conflicting existing identity is rejected.
2. `invite [--out ABSOLUTE_FILE] [--broker PUBLIC_URL]` prints one `MURMUR:`
   base64url line and optionally writes the identical line to a private file. It
   contains public Contact keys and may contain the Server access key. With
   `--json`, `invitation` carries the line and `file` is null when omitted. Treat
   both stdout and the optional file as confidential. An existing output file is never overwritten. Invitation and reply outputs must
   have an already-existing parent and be outside the managed data directory, including
   symlink and filesystem case aliases; a reply path
   must never name a private config, database, cursor or future runtime state file.
   The Invitation must carry a public Server address. Private, loopback, link-local,
   shared-address (100.64/10), unique-local IPv6 and local hostnames are refused
   before an output file is created, including IPv4-mapped IPv6 and alternate
   IPv4 spellings. The policy also refuses `.ts.net`, `.internal`, `.home.arpa`
   and `.lan` names, IPv4 special-use/documentation/testing ranges
   (`192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`),
   IPv6 documentation addresses (`2001:db8::/32`) and the entire `64:ff9b::/96`
   translation prefix. If the current profile uses a private address, supply the same
   Server's public address explicitly with `--broker nats://server.example.com:4222`
   (or `tls://...`). This changes only the Invitation; the profile, Identity keys
   and Server access key are preserved. The override must itself be public.
   Validation does not resolve DNS or prove reachability: `doctor --peer` checks
   the connection after both Contacts have been added. Address refusals print an
   actionable sentence normally; `--json` retains stable error codes on stderr
   (`onboarding.invite-public-server-required` or `onboarding.invite-server-address-invalid`).
   The JSON response retains `containsBrokerCredential` for the application's
   confirmation before copying an Invitation that contains a Server access key.
3. On the other machine, `join --agent-id ID --invite-stdin` reads the Invitation
   from standard input and prints one `MURMUR:` Reply. `--invite-file ABSOLUTE_FILE`
   remains an alternative input; `--reply-out ABSOLUTE_FILE` is an optional private
   copy. With `--json`, `reply` contains the line and `replyFile` is null when omitted.
   Input is bounded at 16 KiB, must be a single complete line, and is type-checked.
   Legacy canonical base64 Invitations and `MURMUR-REPLY:` files are still accepted.
   New output uses unpadded base64url and the shared prefix, with a type inside the data.
4. On the first machine, `add-peer --reply-stdin` completes key import;
   `--reply-file ABSOLUTE_FILE` remains available. Standard input and file options
   are mutually exclusive. GUI code writes the pasted line to stdin and closes it,
   never passing credential-bearing content in argv.
   It refuses silent key replacement, saves a private configuration backup and
   clears only that peer's poisoned dedupe entries. Failure reading the store is
   reported as an unknown reset result, never zero. `restartRequired=false` applies
   to the 2.12 Service, which observes config-file replacement and refreshes only
   Contacts. `contactsReload={mechanism:"config-file",state:"pending"}` describes
   a saved change awaiting observation, not an observed acknowledgement. An older
   Service must first be upgraded; a stopped Service must be started.
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
service mutations; see [Windows CLI](windows-service-cli.md). The 2.12 Service
checks the configuration before inbound messages, delivery receipts and each
queue flush (normally every two seconds). POSIX SIGHUP also requests a refresh.
It pins the original Identity, Server, route and directory. An unreadable or
rejected configuration replacement retains the last valid Contacts so queued
letters can still be sent; no new keys from that replacement are trusted. A
malformed Contact is skipped individually, including at startup, while valid
additions and removals take effect. Repeated failures are logged once until the
reason changes or a valid replacement recovers. Wake-up and other runtime
settings keep their existing restart semantics. Windows uses the file trigger;
only POSIX installs a SIGHUP handler.

`status --json` adds nullable `peers.reload`: `state` is `current`, `partial`
(invalid Contacts skipped), or `retained` (last valid map still used); `count`,
`invalidCount`, `lastSuccessAt`, `lastError` and `lastErrorAt` describe the observed
reload. Errors are safe `agent-config-*` codes. It comes from fresh, PID/store-bound
runtime observation, refreshed every five seconds. A broken on-disk configuration
does not hide this diagnostic; its configured Contact list remains unknown.
No observation or an older Service returns `peers.reload: null`.

A first Contact may come online after the ordinary delivery retry window. On
its first verified positive ACK to a direct letter, the SQLite queue atomically
retries its direct letters stopped by `max-attempts:ack-timeout` or
`max-attempts:unknown-sender:`, or JetStream `max_deliver` exhaustion.
JetStream max-deliver advisories preserve an existing DLQ diagnosis, cannot
overwrite a concurrently settled verdict, and ignore events older than a queue
transition. A termination advisory remains final.
A late ACK of the waiting letter itself can settle it without another send. The
original message ID is kept so the receiver stores it once. Security, policy and
poison verdicts, group deliveries, and established Contacts retain their existing
terminal/bounded behavior. An acknowledged group letter is not evidence of a
direct exchange with each member. Verification includes signature, message binding,
timestamp and durable nonce replay protection. This is transport evidence, not
an Assistant Reply. In plain NATS a new message or `doctor --peer` supplies that
first ACK; JetStream may deliver the original stored message after the Contact
starts. No heartbeat protocol or background AI request is introduced.
This automatic first-exchange recovery currently has no age cutoff and does not
consult the separate dismissed-attention file: an eligible dismissed letter can
also be resent. Dismissal acknowledges attention; it is not cancellation.

Without `--json`, errors are actionable English sentences using the shared
vocabulary; unrecognized codes receive a safe diagnostic action. `--json` keeps
stable error codes on stderr, never echoing Invitation content or private paths.
