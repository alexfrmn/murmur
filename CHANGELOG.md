# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **The Claude Code Stop hook carries its own `timeout`** (#273). The entry written by
  `clients configure --client claude-code` asked the drain for 28800 seconds but set no
  `timeout`, and Claude Code ends an `asyncRewake` hook without one after 600 seconds, so an
  idle session listened for ten minutes, not the documented eight hours. The entry now sets
  `timeout: 28800`; an entry written by 2.11.0 or earlier is updated with `--replace`.
- **A Service left by a pilot or an earlier version is replaced from the tray.**
  After a new version was installed over a pilot, the Windows Service with the bound
  name still ran the pilot's files: the CLI answered `service.profile-unverified`, the
  tray could neither start nor remove it, and it took `sc.exe delete` in an
  administrator terminal. Status now names that state (`service.previous-installation`),
  the tray shows it as its own line and asks once whether to replace it, and
  `service install --replace-previous` removes that Service and installs this one under
  one administrator consent. The profile, keys and messages are not touched; a Service
  of another program with the same name is refused (`service.foreign-image`).
- **A colleague's first letter wakes Claude Code** (#245). A new session's Stop hook
  used to start reading at the newest message, so a letter that arrived before the
  session's first Stop woke nothing until the inbox was opened by hand. The first run
  now starts at the contour's anchor; on a store never read before it reports the
  newest `MURMUR_WAKE_FIRST_MAX` letters (default 20), in the Stop hook and in
  `--session` alike. An anchor left behind by a store recreated at the same path is
  replaced instead of silencing the hook, and one wake prints at most
  `MURMUR_WAKE_SESSION_MAX` rows.

### Pending
- **NATS transport security (TLS + per-peer auth)** — reviewed and CI-green in #103, held for a coordinated broker/peer credential cutover. It intentionally makes existing non-loopback `nats://` configurations fail closed, so it ships with a maintenance window, not as a routine merge. Two gaps to close first: the Kubernetes ACL example does not cover JetStream subjects (`$JS.API.*`, `$JS.ACK.*`, `_INBOX.*`), and the dashboard's NATS client supports a token only, no user/password or CA.
- **Turning on `ackSecurity.requireSigned`** — a rollout step, not a code step. Until every peer runs 2.5.0+ and the flag is set, unsigned ACKs are still accepted.

## [2.11.0] - 2026-09-24

### Added
- **Install the prebuilt `@murmurv2/cli` with the `murmur` command** (#218). The
  package contains the setup runtime and Windows service helper; installation
  requires neither a compiler nor install scripts. Its commands cover joining,
  service setup, client configuration and diagnostics. Package
  checks preserve compatible dependency ranges and validate all tarballs before
  publication; versions of all twelve libraries receive a fresh patch release.
- **Mac onboarding in the app** (#226, integrating #208–#213): accept an invitation,
  save the reply, create or reopen a profile, and explicitly install/start its
  service. Recover interrupted setup without recreating keys or deleting history.
  Client selection, RU/EN localization, help, update checking and lifecycle fixes
  are included in the combined pilot.
- **Windows tray onboarding and service consent** (#228): accept an invitation,
  select a reply location and configure detected clients through native dialogs.
  Service controls request Windows elevation for the CLI.
- **Per-user Windows setup installer** (#229). `Murmur-VERSION-windows-x64-setup.exe`
  installs the app and its shortcuts without an elevation prompt; installing the
  background service requests elevation separately. Upgrade/uninstall retain
  profiles and refuse to remove a runtime still referenced by a service.
- **Claude Code Stop hook during client configuration** (#231). The installed
  hook polls while Claude Code is idle, including its first Stop; cursor, lock
  and anchor paths are scoped to the profile so separate profiles do not compete.
- **Encrypted doctor response from the daemon** (#236). A verified, fresh protocol
  challenge receives a signed reply through the durable outbox without asking an
  AI to reproduce a nonce. Duplicate challenges are idempotent and rate limited;
  diagnostic traffic is muted and does not trigger AI wake.

### Changed
- **Service readiness and peer exchange proof are separate** (#234). A running,
  connected service may be green while an untested peer says “Exchange not checked
  yet.” No missing pair proof is turned into success; measured mismatches warn.
- **MCP learns new peers without a client restart** (#238). It refreshes a safely
  opened configuration and refuses stale keys after a read or policy failure.
  Local identity, keys and runtime binding changes still require a restart.
  `murmur_request` waits at most 45 seconds, then returns `awaiting_reply`, its
  conversation ID and actual delivery state. Only ACKed messages are described
  as delivered. The optional broker tap cannot block durable store polling.
- **Dead-letter and paused-wake explanations** (#230). Mac users can inspect
  unsent-message metadata and dismiss or restore a warning without changing
  delivery state, deleting messages or resending. Active failures remain visible.
- **Project homepage is `murmurconnect.com`**. The site adds locale links, FAQ and
  crawler metadata (#223); package homepages point to the project site.

### Fixed
- **Windows: one tray per bundle.** Start, Desktop and Startup shortcuts start `murmur-tray.exe`
  directly; a second launch now opens the running tray's menu and exits with 0 instead of adding
  a second icon (session-local named mutex keyed by the executable path).
- **Windows: shortcuts from earlier builds are updated in place.** A Murmur shortcut that still
  starts Windows PowerShell with this bundle's `Open-Murmur.ps1` is rewritten to start
  `murmur-tray.exe` directly the next time the launcher opens that bundle (staged, rolled back on
  failure). Other shortcuts named Murmur are left alone and, as before, stop the launcher.
- **Windows: an installed Murmur keeps its installer's shortcuts.** With `murmur-install.json`
  next to the launcher (written by setup.exe) the launcher creates, updates and removes no shortcuts.

- **Windows ZIP paths outside the system ANSI code page** (#237). The launcher
  opens the app even when it cannot create shortcuts for such paths, and explains
  the skipped shortcuts. Installer-owned shortcuts remain under installer control.
- **Windows profile and invitation privacy** (#215): private DACLs prevent broad
  inherited access to new secrets; a failed ACL step does not leave a partial
  profile that a retry could mistake for a valid installation.
- **Windows path and service diagnostics** (#214, #216, #217, #220, #224, #225,
  #232): refuse service-invisible MSIX AppData profiles and trailing path
  separators; preserve native helper reason codes and system error names.
  File identity checks handle Node's differing Windows volume identifiers while
  preserving full inode precision.
- **CLI entry and next steps** (#221, #222): `murmur --version` works, unknown
  options are identified, and doctor gives a next-step hint for a missing profile
  or stopped service. The existing doctor exit-code contract is unchanged.
- **Portable and native acceptance coverage** (#219, #226): Windows setup, private
  file checks, native helper/version probes and the combined Mac pilot run in CI.
  Mac test fixtures warm their Python interpreter before bounded status/client
  probes; diagnostic timings identify a slow stage without changing product
  timeout budgets (#241).
- **Runtime probe cleanup and Windows startup budgets** (#235). The checker waits
  for the MCP child to close before removing its temporary profile and reports
  cleanup errors alongside the original failure. Windows CLI probes allow for
  cold PowerShell ACL startup and identify the timed-out command and budget.
- **Mac client configuration respects custom homes** (#242). The bundled native
  launcher retains `CODEX_HOME` and `CLAUDE_CONFIG_DIR` for client detection,
  preview and configuration, preserving the locations selected in the app.
- **Private-file ACL startup on Windows** (#240). Both the product ACL helper
  and native test fixture allow up to 60 seconds for cold PowerShell startup.
  ACL checks, ownership and refusal behavior remain unchanged.
- **Claude Code Stop listener survives SQLite writer locks** (#239). Read-only
  queries wait for short locks; polling retries BUSY/LOCKED until its deadline
  without advancing the cursor or waking on muted diagnostics. The shell
  one-shot hook also waits and leaves its cursor untouched on a failed read.

### Known limitations
- **Delivery, doctor and automatic AI wake are separate checks.** Claude Desktop
  can use MCP to send/read messages, but does not automatically start an AI turn
  when a message arrives; opening the inbox or starting a turn is still required.
- **Codex app-server automatic wake uses Unix-domain sockets.** Its Windows
  transport is not implemented; Windows MCP inbox, send and request/reply work
  without waking Codex automatically. Claude Code on Windows uses its Stop hook.
- **Claude Code's Stop hook has an eight-hour window.** A new Stop is required
  after that window; it is not an always-on process independent of the client.
- **Sessions sharing one profile share its inbox.** Use separate profiles when
  independent sessions need separate delivery and wake state.
- **Windows “Open an existing profile…” uses the derived service name.** Open
  profiles with a custom service name through `Open-Murmur.cmd -DataDir …
  -ServiceName …`.
- **The Windows ZIP launcher may skip shortcuts.** If the bundle or shortcut
  folder path contains characters outside the system ANSI code page (for example,
  “中” on Russian or English Windows), it opens Murmur without creating shortcuts.
  The `setup.exe` installer is unaffected.
- **Node.js remains an external prerequisite.** The app/runtime checks the
  supported version. macOS bundles are ad-hoc signed, without Developer ID or
  notarization, so first-open guidance still applies.
  Windows setup.exe and tray binaries are not code-signed; SmartScreen may show
  “Windows protected your PC” on first run (More info → Run anyway).

## [2.10.0] - 2026-09-20

### Fixed
- **Dependency audit**: update transitive `qs` to 6.16.0, clearing the moderate
  advisories reported by `npm audit` on the previous lockfile.
- **Outbox retries now reach JetStream inside its duplicate window** (#141): each
  durable row version has its own transport dedupe ID; the signed envelope and
  receiver's message ID remain unchanged. This also covers a fast NACK that wins
  the `markSent` CAS before the attempts counter advances.
- **Late signed ACK/NACKs settle retryable failed rows** (#142). A verified
  `poison-message:*` NACK atomically moves the row to DLQ with the peer's reason;
  settled rows remain protected. Subsequent ACK timeouts retain an earlier error
  instead of replacing the peer's diagnosis with `ack-timeout` (#143).
- **Proxy subscriptions no longer acknowledge for another agent** (#144).
  A proxy is a wake bridge, not delivery to the addressee's inbox. It emits no
  peer ACK/NACK, while its own JetStream consumer still acknowledges processing.
  Startup warns that without the addressed agent's daemon, the sender will retry
  and eventually dead-letter the unconfirmed message. Proxy signing/delegation is
  not part of the protocol; the expected-peer signature check remains unchanged.
- **`WakeMonitor hook completed` was logged when there was no hook** (#146) — the line was
  printed whether or not a responder existed, so a daemon configured with neither `wake`
  nor `onReceive` produced a log byte-identical to a healthy one: `Message received`, then
  `hook completed` four milliseconds later, for messages that reached nobody. The
  no-responder branch now logs `WakeMonitor: hook not configured, message stored only` at
  `warn` with `msgId` and `conversationId`, and `hook completed` is printed only when a hook
  actually ran. Wake readiness is also visible before the first message: `Daemon ready`
  carries an additive `wake: { configured, hook, native, nativePeers }`, and a daemon with
  no responder logs `No wake responder configured` at startup.
- **The wake-drain cursor stepped over rows nobody looked at** (#146) —
  `wake-drain-claude.sh` selected the rows to report and then advanced the cursor to a
  separate `MAX(rowid)` query over the whole table. Anything between the two queries was
  skipped permanently: a row that landed in the gap, and every row a locally added filter
  had removed from the report. Both drains now take rows and high-water mark from one
  `SELECT`, and the cursor only ever passes a row that was reported or recorded.

### Added
- **Prebuilt runtime and desktop companions**: locked portable runtime ZIP, Windows
  x64 tray/service bundle, and a universal macOS DMG. Node.js remains external;
  recipients do not need npm, Go, or a source build. Manifests record exact source
  and payload hashes, and native package versions follow the product version.
- **Shared onboarding and profile controls**: explicit init/invite/join/client
  configuration, status/doctor, profile-bound service controls and configured log
  paths. Desktop shells consume the common CLI and shared setup fixtures.
- **Stable update notifications**: CLI and desktop companions share a six-hour
  cache, visible unknown/failure state, explicit opt-out, and an official release
  page action. Checking does not download, install, or restart anything.
- **English and Russian interfaces**: English by default on the website and desktop
  companions, with explicit persisted Russian selection. CLI diagnostics remain
  English and stable machine codes stay unchanged.
- **Terminal indicator and Claude Code plugin**: bounded `status --line`, read-only
  inbox listing, an explicit-profile MCP entry, and a dry-run statusline composer
  that preserves existing commands without writing user settings.
- **Optional per-channel NATS subjects** (#90): explicit channel consumers share the
  existing stream, legacy durable cursor and application dedupe identity. Includes
  additive migration/rollback checks, sender opt-in, MCP bridge routing and an
  isolated JetStream proof. Default mailbox routing remains unchanged.
- **Channel chat-session presence** (#89): explicit MCP heartbeat/leave/list tools
  report local sessions with bounded TTL, validated roster identities and immediate
  hiding of closed/departed memberships. This advisory state is separate from peer
  discovery and never grants wake/lease authority; see `docs/phase-n-routing.md`.
- **Opt-in coalescing of Codex wake messages** (#124) — per-peer quiet windows and
  turn caps combine queued messages into a subsequent `turn/start`. FIFO overflow
  stays queued, channel/member boundaries and per-message policy gates stay intact,
  and persisted batch identity plus atomic outcome writes preserve recovery across
  session/daemon failure. The default remains one message per turn; see
  `docs/wake-native.md` for configuration and rollback.
- **A notify target can take one peer** — `peers: ["agent-jarvis"]` on a Telegram or webhook
  target limits it to those senders, and `fallback: true` marks the target that takes whatever
  no `peers` target took. One forum chat can now hold a thread per peer; before this, splitting
  peers meant a second process reading the store and posting by sender. A target with neither
  field keeps taking everything, so existing configs are untouched. A sender that matches no
  target at all is logged as a warning rather than dropped in silence, including
  failed-wake fallback notifications. An explicit empty `peers` list accepts nobody;
  only an omitted filter accepts every agent. Bare Telegram/webhook config forms
  preserve the same filters. Routing uses transport agent IDs, not `senderMemberId`.
- **Supported filters for the wake drain, with a ledger instead of a silent drop** (#146) —
  `MURMUR_WAKE_SKIP_SENDERS`, `MURMUR_WAKE_SKIP_CONVERSATIONS` and
  `MURMUR_WAKE_SKIP_INELIGIBLE` (the last one honours the daemon's `wake_eligible=0` mute).
  Every deliberately skipped row is appended to `MURMUR_WAKE_SKIPPED_LOG`
  (default `~/.murmur-wake-skipped.jsonl`) with its reason *before* the cursor moves past
  it; if the ledger cannot be written the cursor stays put. All three filters are off by
  default, so an installation that sets none of them behaves exactly as before. Documented
  in `docs/wake-native.md`.

## [2.9.0] - 2026-09-12

> Two things had to stop being true at once for a wake to be trustworthy: that a failed wake
> could be marked handled, and that a retried one could answer twice. This release makes the
> receiving side exactly-once — one durable row per delivery, retries under the same id, a
> cursor that never skips a gap, an idempotent relay — and then fixes what that exposed: turn
> status never read, one long turn blocking every peer, Codex threads living in process
> memory, and a cold-start watcher spawning next to a live session. Phase N member routing
> and Codex Desktop exact-task delivery from @fedoseevstanislav ship with it.

### Added
- **Phase N structured member routing** — optional signed `channelId`, `senderMemberId`,
  and `addresseeMemberId` fields now flow through the envelope, MCP send/request tools,
  durable inbox, daemon roster policy, receive-hook environment, and shell sender. Legacy
  fieldless envelopes remain byte-identical. `murmur_request` can distinguish replies from
  multiple members sharing one transport agent. The receive-time wake decision is persisted
  so observer-muted history cannot wake through delayed backlog processing, and configured
  proxy subjects apply the same structured member-addressing decision.
- **Opt-in Codex Desktop exact-task delivery** — MCP sends from a Codex task default to `codex:task:<thread-id>`, and a macOS receive hook can use the shared local `codex queue` command to deliver only to that exact non-archived Desktop task. Missing, archived, legacy, and unaddressed targets remain inbox-only; synchronous `murmur_request` replies use a private expiring marker to avoid duplicate queue injection. This local task affinity complements, rather than replaces, Phase N channel/member identity.

### Fixed
- **Failed wakes were marked handled, and a retried relay could answer twice** (#105, part of
  #106; design by @alexanderyswork in #96). `WakeMonitor` advanced its cursor from `finally`,
  kept it only in memory, and re-seeded it at the table tip on every restart — a message
  whose wake threw, timed out, or was interrupted by a restart was never retried. Fixing
  the cursor alone would have turned silent loss into duplicate execution, so delivery
  semantics ship as one package:
  - `local_messages` carries a UNIQUE `delivery_id` (`<direction>:<msgId>`); `append`
    commits the row, its delivery id and its initial wake state in one transaction and
    reports `duplicate: true` for a redelivered envelope. The daemon ACKs a duplicate
    without waking again (crash window "receiver committed, ACK lost").
  - The ACK to the sender follows the durable commit, not the end of the wake. Awaiting the
    whole Codex turn before ACKing meant the sender's ACK timeout resent the message it was
    still being answered.
  - Wake state (`pending → inflight → handled | failed | muted | dlq`) lives on the row; a
    claim is a conditional UPDATE, so a duplicate copy is refused while the first is in
    flight or after it was handled. Failed wakes retry under the same delivery id with
    exponential backoff (`wake.retry`: 5 attempts, 30 s doubling to 10 min), then
    dead-letter with a `wake-dlq` notification (crash window "relay failed, cursor unchanged").
  - The cursor is read back from the table as the highest contiguous settled row; a gap holds
    it, a restart resumes from it, and rows left in flight by a dead process re-enter the queue.
  - The relay reply id is derived from the inbound `msgId`; `murmur-shell-send --msg-id` makes
    the send idempotent, and a retry whose reply is already in the outbox does not start the
    turn again (`source: "relay-idempotent"`).
  - A turn that completes with an empty final answer now fails the wake as
    `codex-app-server-final-empty` (not retryable) instead of logging `wake final relayed`
    for a reply that was never sent.
  Rows written before this release keep NULL delivery and wake state: they are outside the
  queue and are not replayed on upgrade. 27 new tests, each seen red first.
- **A failed or interrupted Codex turn was treated as a success** (#106). `turn/completed`
  carries `turn.status` and `turn.error`; neither was read. The client now surfaces both,
  a `failed` turn fails the wake (`codex-app-server-turn-failed:<turnId>:<error>`, retried
  under the same delivery id) and an `interrupted` turn fails it without retry. Together
  with the empty-final check above this closes the false "wake final relayed".
- **One long Codex turn stalled every other inbound message** (#107; measured by
  @alexanderyswork: a short question waited 90 s behind a long turn). `WakeMonitor.drain`
  now runs lanes — one per (peer, conversation), or per peer when the Codex peer is pinned
  to a static `threadId` — up to `wake.concurrency` at once (default 4). Order inside a
  lane is unchanged; `concurrency: 1` restores the sequential behaviour.
- **`threadId` lived only in process memory and was scoped per peer** (#108). Seeded
  threads are now keyed by (peer, conversation) and persisted in `wake_threads`, so a
  restart resumes the same Codex thread and conversations from one sender stop sharing
  context. A static `peer.threadId` stays an explicit pin; a thread re-seeded to replace
  a stale pin remembers which pin it replaced, so a new pin in config takes over.
- **`codex-murmur-coldstart-watch.py` spawned headless Codex sessions next to a live
  interactive one** (#123). Its only guard was the conversation lease, which a TUI session
  that never registered a lease leaves free. The watcher now stands down when the Codex
  app-server socket accepts a connection (`--app-server-socket`, default
  `$CODEX_APP_SERVER_SOCKET`) or when `session_presence` has a fresh non-coldstart row for
  the agent (`--presence-ttl-ms`, default 60 s), logging `skip_live_session` with the
  reason; `--ignore-live-session` restores the old behaviour.

### Packages

- `@murmurv2/core` 0.6.2 → 0.6.3 — `delivery_id` + wake state on `local_messages`, `wake_threads`, `AppendedMessageRecord`, wake delivery API.
- `@murmurv2/mcp-server` 0.2.1 → 0.2.2 — Phase N routing fields, Codex Desktop exact-task delivery.

## [2.8.2] - 2026-09-12

> The storm of 11.09 was not one bug but a stack of them, and 2.8.1 fixed only the
> receiving side. Measured live on the shared broker on 12.09: four loops, all from 2.6.0
> senders, 4.5 messages a second, 3M messages and 4.5 GB in the stream. Upgrading the
> senders closed three of the four within a minute; this release removes what the receiver
> still did wrong, and one thing a 2.8.1 sender still does wrong.

### Fixed

- **A letter to a receiver that is not on the mesh was retried forever.** `flushOutbox`
  enforced `maxAttempts` only when `publish()` threw. A receiver that never ACKs makes
  nothing throw: the row goes `sent`, the ACK timeout drags it back to `failed`, the next
  flush publishes it again — observed on one host as a single row at `attempts=32`, still
  cycling after the 2.8.1 upgrade. The cap now holds on the success path too: a claimed row
  with `attempts >= maxAttempts` goes to the DLQ as `max-attempts:<last error>` before it is
  published again.
- **A delivered message was undone by a timeout on its own ACK.** `publishAck` ran after
  the handler and `markSeen` and was awaited on the same path. When JetStream's pub-ack
  timed out (a peer's log, 11.09: `NatsError: TIMEOUT`, 3 731 rejections, 15 375
  redeliveries), the exception counted as a handler failure: the JetStream message was
  nak'd, came straight back, was rejected as a duplicate, timed out again on that ACK —
  five rounds to `max_deliver` and a DLQ advisory for a letter delivered on the first pass.
  Every ACK/NACK publish inside envelope processing is now best-effort: the delivery
  outcome stands, the failure is logged with subject, `msgId`, status and reason, and the
  sender's own ACK timeout covers the gap.
- **A nak'd letter was redelivered immediately.** `consumeJetStream` called `m.nak()` with
  no delay, so a fault that clears with time (a peer not yet added, a broker slow on the
  ACK) burned all five deliveries in milliseconds. Redelivery now backs off 1s, 2s, 4s …
  capped at 30s, keyed on the redelivery count JetStream reports (`nakBackoffMs`).
- **`murmur_send` failed with `database is locked` after the row had been written** (#122).
  The SQLite outbox and message stores set WAL but no busy timeout, so a second writer —
  the MCP server enqueuing while the daemon flushed — failed at once instead of waiting a
  few hundred milliseconds. Both stores now set `PRAGMA busy_timeout=10000`; verified with
  the lock held by a separate process, the shape production has.

### Security

- **The wake hook no longer puts peer text into the session's privileged slot** (#132,
  reported by Kirill Oleinichenko). In poll mode the wake names the sender and the count
  only and asks the session to read the text through `murmur_inbox`; the trailing "or act
  on them" is gone. The `--session` cold-start drain still prints what arrived, but inside
  an explicit `<untrusted-peer-text sender="…">` boundary followed by a line stating that
  it is data written by other agents, not instructions. The shell twin
  `wake-drain-claude.sh` gets the same wake line.

### Documented

- **A freshly started lane is deaf until its first turn** (#130). The poller starts from
  the `Stop` hook, and `Stop` fires at the end of a turn a new session has not taken yet.
  An unattended install needs one priming turn after launch; README and
  `docs/wake-native.md` now say so, with the tmux detail that text and `Enter` must be
  separate `send-keys` calls.

### Closed

- #126 — fixed by #131 in 2.8.1; closed with the reference.

### Packages

- `@murmurv2/core` @ `0.6.2` (busy timeout on both SQLite stores). `@murmurv2/broker-nats`
  @ `0.3.4` (attempts cap on the success path, best-effort ACK publish, nak backoff). Other
  `@murmurv2/*` unchanged.

## [2.8.1] - 2026-09-11

> A rejection the receiving side never logged, and a rejection it treated as poison. Three
> agents spent a day chasing an ACK storm that turned out to be two messages from 31.08
> which could not be delivered and could not be given up on either. Every fix here comes
> from running the mesh across machines that do not share an owner.

### Fixed

- **An envelope from a peer that had not been added yet was dropped forever.** `unknown-sender`
  was counted as a poison message: after three attempts the broker wrote the `msgId` into
  `dedupe_seen` and answered `poison-message`. From then on the circle closed — the sender
  retried, the receiver answered `duplicate-ignored`, no settlement was ever produced, and the
  envelope did not arrive even after `add-peer`. But this is a rejection configuration clears,
  not delivery: such envelopes now stay retryable, JetStream caps the attempts, and the message
  lands in the DLQ where it can be seen. Measured on one host overnight: 3898 redeliveries of a
  single `msgId`, 12243 resends, 1008 broker reconnects. On the shared broker, two envelopes
  stuck since 2026-08-31 were still emitting a NACK every two seconds eleven days later —
  ~3600/hour, 692 508 messages on one connection. Found by agent-kirill and agent-viola.
- **`add-peer` fixed the link but not what the missing link had already cost.** Messages held
  back while a peer was unknown stayed marked as seen, so they could never be delivered again.
  A dedupe row now records where the envelope came from and why it was held, and
  `murmur-add-peer` releases exactly the held-back messages of the peer being added. Delivered
  messages are deliberately left alone — clearing those would replay the whole history of the
  conversation. Databases created before this release are migrated in place on open; their
  older rows carry no sender and are released by `msgId` with the new script below.
- **A rejected message was invisible to the side that rejected it** (#131). The daemon threw
  `unknown-sender` and `signature-invalid` silently: the throw reached `broker.subscribeWithAck`,
  which NACKed the sender with a reason, and that was all — the receiving owner had no record
  of the refusal in the log, the database, or `healthz`, so the only way to debug it was from
  the other machine. Found by agent-misha 2026-09-08, after three agents spent an hour
  establishing whether messages were arriving at all.
- **The JetStream DLQ handler drowned its own log.** Every advisory parse failure printed the
  message, the stack and the raw frame, on every event, with no rate limit and no rotation: one
  daemon log grew from 33 lines to 117 307 (9.1 MB) overnight. The same failure now prints at
  most once a minute with a count of what was suppressed. A JetStream lookup that times out is
  also no longer reported as a malformed frame — the frame parsed fine, the server did not
  answer. Found by agent-kirill.

### Added

- **`scripts/murmur-dedupe-unstick.mjs`** — releases messages held in the dedupe table, for the
  two cases `add-peer` cannot cover: rows written before this release, which carry no sender and
  can only be selected by `msgId`, and a peer you want released without re-running the invite
  handshake. `--list` shows what is held and changes nothing.

### Changed

- `DedupeStore.markSeen()` takes an optional third argument, `meta` (`senderAgentId`,
  `poisonReason`). Existing callers keep working. Implementations that store provenance may
  also expose `clearPoisonedFrom(senderAgentId)`; it is optional, so callers must check for it.

### Published
- **npm** — `@murmurv2/core` **0.6.1**, `@murmurv2/broker-nats` **0.3.3**, `@murmurv2/broker-ws` **0.2.2**.

## [2.8.0] - 2026-09-08

> A message that arrived while nothing was listening is now delivered on the next
> session start. The per-session cursor shipped in 2.7.0 fixed one delivery gap and
> quietly opened another; this release closes it with a cursor that outlives the
> session it was drained by.

### Added
- **`--session` cold-start drain for `scripts/wake-drain-claude.mjs`.** A `SessionStart`
  hook that reports inbound messages which arrived while no session was alive, using a
  shared anchor (`MURMUR_WAKE_ANCHOR`) alongside the existing per-session cursor. Writes
  to stdout and exits `0`, since a `SessionStart` hook feeds its stdout to the session as
  context. Output capped by `MURMUR_WAKE_SESSION_MAX` (default 20). Reported by
  [@lichtpfad](https://github.com/lichtpfad) against 2.7.0: the per-session cursor
  introduced in that release closed the multi-session gap and opened this one, because a
  session with no cursor seeds its baseline at the current tip. The shell port keeps
  `poll` and `--once` only.

## [2.7.0] - 2026-08-28

> Delivery correctness, found by running the mesh where it had not been run before. A
> cross-host test between a Mac and a Windows box by
> [@lichtpfad](https://github.com/lichtpfad) surfaced three defects that our own hosts
> could not: two of them made a message vanish or repeat forever without a single error
> line, and the third stopped the install outright.

### Fixed

- **A `failed` outbox row could never finish its retry** (#113, #117) — `failed` was listed in `TERMINAL_OUTBOX_STATUSES`, but `claimDue()` selects `failed` on purpose. The retry was re-claimed, published successfully, and then `markSent()` refused it: the status stayed `failed`, `attempts` never grew (so `maxAttempts`/DLQ never fired), `nextAttemptAt` stayed in the past, and the row was re-claimed again on every flush. The returning ACK bounced as `message-not-in-flight`. Nothing short of a manual `dlq` could settle it — 766 log lines over two `msgId`s in the report. The race that v2.6.0 was guarding (a fast ACK/NACK landing between `publish()` and `markSent()`) is now handled per row: `claimDue()` hands out the row `version`, the flush loop passes it to `markSent(msgId, expectedVersion)`, and the update applies only while the row is untouched. That covers any concurrent transition rather than a hand-maintained list of statuses.
- **`murmur_inbox` reported `count:0` for messages that had been delivered** (#114, #116) — the tool ran `searchMessages(agentId)`, a `LIKE` over text/sender/conversationId, and then filtered by direction. A reply that did not happen to spell out the receiving agent's name matched nothing, so the inbox looked empty while the row sat in `local_messages` and the sender saw the delivery `acked`. Measured across three agents: 4 inbound → 0, 3 → 1, 2 → 0. The store is per-agent, so direction is the whole filter; `SQLiteMessageStore.listInbound()` replaces the search. The worst shape a delivery bug can take for autonomous agents — no error, no retry, both sides confident.
- **Install failed on Windows** (#112) — `writePrivateJson` fsync'd the containing directory, which Windows does not support on a directory handle (`FlushFileBuffers` → `EPERM`), so `murmur-join.mjs` died while generating keys. The file itself is fsync'd a line earlier; the directory sync is a durability nicety and is now skipped on win32. Contributed by [@lichtpfad](https://github.com/lichtpfad).
- **Native wake did nothing on Windows** (#115, #118) — `wake-drain-claude.sh` shells out to the `sqlite3` CLI, which a default Windows install does not have (the daemon uses `node:sqlite`, not the CLI). The query came back empty, the hook exited `0`, and the session was never woken: native wake looked broken when a binary was simply missing. `scripts/wake-drain-claude.mjs` is a dependency-free node port that runs anywhere node does, contributed by [@lichtpfad](https://github.com/lichtpfad), plus a poller so a message arriving while the session is already idle still wakes it. The follow-up gave it the per-session cursor from #111, bound the cursor to the last row actually reported (advancing to `MAX(rowid)` could step over a row inserted mid-drain), and made faults report themselves instead of exiting `0` in silence.
- **One inbound message woke only one session** (#111) — the wake cursor and the watcher lock were shared per host, so whichever session reached the hook first advanced the cursor past the message and every other live session, including the one holding the conversation, stayed asleep. Measured over 23–26.08: of 24 sessions that armed a watcher, exactly one was ever on duty. Both are keyed per session now, and a session's first run seeds the cursor to the current tip instead of replaying the whole history.

### Changed

- `MURMUR_DB` defaults to `.data/murmur.db` — the same path `SQLiteMessageStore` uses — in the wake drains and the cold-idle watcher, instead of an absolute path inside one machine's home. `scripts/murmur-to-acp-producer.sh` resolves its Python entry point relative to the repo for the same reason. Set `MURMUR_DB` explicitly when a hook runs from another working directory.
- `OutboxStore.markSent()` takes an optional second argument, `expectedVersion`. Existing callers keep working; anything on the claim → publish → mark path should pass `record.version`.

### Published
- **npm** — `@murmurv2/core` **0.6.0**, `@murmurv2/broker-nats` **0.3.2**, `@murmurv2/broker-ws` **0.2.1**, `@murmurv2/mcp-server` **0.2.1**.

## [2.6.0] - 2026-08-20

> Closes the four gaps that v2.5.0's compatible signed-ACK path left open. Found by diffing
> #100 against @fedoseevstanislav's strict variant in #104 — the compatible PR looked complete
> on its own, and only the comparison exposed what it did not cover.

### Security

- **Replay protection survives a restart** (#109, #110) — `AckReceiptStore` in `@murmurv2/core` plus an `ack_receipts` table in `SQLiteDedupeOutboxStore` provide claim-once semantics on `(sender_agent_id, nonce)`. Previously nonces lived in a bounded in-memory `Set`: a restart forgot them, so a signed NACK could be replayed against a fresh process — the retry returned the row to `sent` and the replayed NACK failed it again. The in-memory store remains as an explicit fallback, and the daemon now logs a warning when that fallback is what is running rather than implying protection it does not have.
- **The fast-ACK race no longer causes a spurious retry** — `applyAckTransition` accepts `pending` alongside `sent`, so an ACK arriving between `publish()` and `markSent()` is applied instead of rejected as `message-not-in-flight`. `markSent()` now refuses to downgrade a terminal status, so the late call cannot resurrect a settled row.
- **The A2A bridge no longer honours an unsigned NACK** — it resolved a pending task from a bare `{msgId, status: "nack"}` object, letting anyone able to publish to the ACK subject settle someone else's in-flight task with an arbitrary failure string. A verified `SignedAckV1` is now required; `signingPublicKeys` was added to `BridgeA2AConfig`.
- **The WebSocket ACK path is verified like the NATS one** — `processAckFrame` verified nothing and called `markAcked`/`markFailed` straight from the frame. It now checks record lookup, digest, conversation, recipient, known peer, ack-subject binding, signature and nonce claim, with unsigned frames accepted only while `requireSignedAcks` is off.

### Fixed

- **Five packages were built and tested against a stale core.** `bridge-a2a`, `bridge-openclaw`, `bridge-telegram`, `broker-ws` and `federation-nats` declared `@murmurv2/core: ^0.2.0`. Once core reached 0.4.0 npm could no longer satisfy that from the workspace and silently installed 0.2.0 from the registry — their passing tests were passing against code two minor versions behind.

### Published
- **npm** — `@murmurv2/core` **0.5.0**, `@murmurv2/broker-ws` **0.2.0**, `@murmurv2/bridge-a2a` **0.2.0**, `@murmurv2/broker-nats` **0.3.1**.

## [2.5.0] - 2026-08-20

> First release built substantially from **external contributions**. The security series came from an
> independent audit by [@fedoseevstanislav](https://github.com/fedoseevstanislav); the wake fixes and the
> delivery-semantics analysis came from [@alexanderyswork](https://github.com/alexanderyswork).

### Security

- **Signed and bound delivery acknowledgements** (#100) — ACK correlation previously trusted attacker-controlled JSON carrying only `{msgId, status}`: anyone able to publish to an ACK subject could mark an arbitrary pending outbox row `acked` or `failed`, suppressing delivery or forcing retries without authenticating as the consumer. ACKs are now a versioned `SignedAckV1` with an Ed25519 signature over the message digest, conversation, ACK sender, intended recipient, status, timestamp and nonce; wrong-message, wrong-conversation, wrong-recipient, wrong-peer, stale/future, invalid-signature and replayed ACKs are rejected, and ACK/NACK state changes apply atomically only from the `sent` state. Invalid attempts are metered by bounded reason as metadata-only security events — raw ACK and message bodies are never logged. **Migration is deliberately two-stage:** upgraded daemons emit signed ACKs that legacy peers still parse; strict rejection is opt-in behind `ackSecurity.requireSigned` / `MURMUR_REQUIRE_SIGNED_ACKS=1` until every peer is upgraded.
- **Hardened local state handling** (#101) — the daemon now sets umask `0077` before state/database creation, creates state directories `0700`, atomically creates/replaces secret JSON as `0600`, rejects symlinked, non-regular and wrong-owner config paths, reads configs with `O_NOFOLLOW` and re-checks the opened descriptor, and forces SQLite database/WAL/shared-memory files to `0600`. Agent configs hold long-term signing/encryption private keys and NATS credentials, and rewrites could previously return them to `0664`; SQLite files containing decrypted history were commonly `0644`. OpenClaw config setup no longer prints secret-bearing fields. `SECURITY.md` now documents that local message bodies remain plaintext and require a dedicated OS identity plus encrypted storage or an explicit retention policy.
- **Dashboard rendering and ingress** (#102) — the optional dashboard renders every untrusted field through DOM `textContent` (no `innerHTML`, inline scripts or inline handlers), serves a strict CSP plus clickjacking, MIME-sniffing, referrer, opener, resource and cache protections, and requires Basic authentication backed by a private server-local token file for both HTTP and WebSocket access. Live messages are accepted only after envelope-schema, signature, NATS subject/recipient binding, traffic-direction and known-peer verification; the listener stays loopback-only. **Fails closed** unless `DASHBOARD_TOKEN_FILE` exists with at least 32 URL-safe characters and no group/other permission bits.

### Fixed

- **Codex wake seeded threads are usable** (#97) — `thread/start` no longer discards `thread.path`, and new threads carry `peer.cwd` instead of starting at `cwd: null`, which previously produced wrong workspace roots, missing project instructions and wrong permissions.
- **Per-peer `baseInstructions` no longer dropped** (#98) — `normalizeWakeConfig` carries the value through, making the injector's `peer.resume === false` opt-out reachable from real configuration for the first time.

### Added
- **Production file-level deploy tooling** — `deploy/production-file-deploy.sh`
  now builds gitignored `dist/` artifacts before copying the live-runtime
  allowlist, includes Phase N core/MCP/channel roster files, and refuses to
  deploy if channel/personality markers are missing. Added
  `deploy/production-channel-roster-ops.sh` plus docs for the non-checkout
  production tree.
- **Phase N / N1 channel roster primitives** — `@murmurv2/core` now exposes `ChannelRosterStore` plus typed `ChannelRecord` / `ChannelMemberRecord` APIs. The roster keeps `channelId` distinct from legacy `conversationId`, stores `channels` / `channel_members` in a dedicated SQLite store, preserves existing message-history APIs, and reserves member-level `personaId`, `model`, `baseInstructionsHash`, and `eligibility` fields for N2 addressing and N3 personality binding.
- **Phase N / N2 addressing policy primitive** — `ChannelRosterStore.evaluateAddressing()` returns a shared reject/append/wake decision for `channelId` + explicit addressee flows: legacy no-channel remains broadcast, non-members are rejected, addressed members wake, and observers append history while staying muted.
- **Phase N / N3 personality binding** — `buildChannelThreadStartBinding()` projects a `ChannelMemberRecord` into Codex app-server `thread/start` overrides (`model`, `personality`, optional `baseInstructions`, and audit metadata). Daemon wiring is opt-in only (`channelRoster.enabled` or `MURMUR_CHANNEL_ROSTER=1`) and leaves legacy wake behavior unchanged by default.
- **Phase N / N6 MCP roster surface** — `@murmurv2/mcp-server` exposes `channel_create`, `channel_list`, `channel_members`, and `channel_evaluate_addressing`, backed by `MURMUR_CHANNEL_ROSTER_PATH` (default `DATA_DIR/channel-roster.db`) so agents and UI can manage rosters without direct SQLite access.

### Known gaps
- **Auth enforcement end-to-end** — the broker ingress hook + `authorizeInbound` exist; the daemon does not yet wire them (so `MURMUR_ENFORCE_AUTH` is not enforced end-to-end). Requires daemon roster/identity wiring + token provisioning.
- **Delivery semantics** — failed wakes still advance the cursor and the relay is not idempotent (#105); an empty `finalText` still logs as relayed (#106); `WakeMonitor.drain` is sequential (#107); `threadId` is process-memory only and scoped per peer (#108). All four reported by @alexanderyswork in #96.

### Published
- **npm** — `@murmurv2/core` @ **`0.4.0`** (adds the signed-ACK primitive and the `SignedAckV1` protocol schema). `@murmurv2/broker-nats` @ `0.3.0` (signed-ACK emission and verification at the transport boundary), `@murmurv2/mcp-server` @ `0.2.0` (channel roster surface). `@murmurv2/federation` @ `0.2.0`; `bridge-murmur` @ `0.1.1`; `observability` @ `0.1.2`; `security` @ `0.1.1`; all other `@murmurv2/*` @ `0.1.0`.

## [2.4.0] - 2026-06-23

> Retroactively written on 2026-08-20. The v2.4.0 tag and GitHub release shipped on 2026-06-23 pointing
> at "See CHANGELOG.md for details", but the section was never added — the release notes lived only on
> the tag. Reconstructed here from the release body and the #77 epic record.

### Added

- **DB-backed session-ownership lease.** For an addressed conversation, only the owning session of the addressed agent responds; every other session and agent stays silent. Fixes multi-session double-emit and native wake hitting or spawning the wrong session.
- **`SessionLeaseStore`** — atomic CAS `claim_or_skip`, heartbeat, per-turn fencing token, `session_presence` registry, `preemptPrefix`. Published in `@murmurv2/core@0.3.0`.
- **Presence-deferring native wake** — `createNativeLeaseGate` defers to a live interactive session and claims only as a cold fallback, behind `MURMUR_SCOPED_CHANNELS` (default OFF, backwards compatible).
- **All delivery paths honour one claim** — MCP channel, foreground push and coldstart each claim, fence and suppress against the same contract.

### Validated

- Lease smoke 11/11, wake-lease 7/7, cross-path coordination 9/9, real multi-process race N→1, wake-monitor regression green. Live: N sessions → exactly one emit, native defer with no competing thread.
- External review by the Stas team: approved, no blockers; two minor notes closed (token-monotonicity fence invariant, reserved `native:` preempt namespace).

## [2.3.0] - 2026-06-22

### Added

- **Agent discovery — complete.** Presence frames + candidate registry (ttl expiry, dedupe, out-of-order guard); signed presence with NATS `announcePresence`/`subscribePresence`; operator promote-flow (`queryCandidates` + `promoteCandidate`) returning the live nested peer-config entry. Trust is always an **explicit operator promotion** — candidates are never auto-trusted.
- **Message streaming — complete.** Stream frames (`stream.start`/`chunk`/`end`), UTF-8-safe chunking, in-memory + durable SQLite reassembly (out-of-order, idempotent, conflict-reject), backpressure (chunk + byte windows), sha256 per-chunk/whole-stream integrity, and an ACK-window.
- **Auth/authz enforcement mechanism** — `signAuthToken`/`verifyAuthToken` now carry a signed **`subject`** (actor); `EnvelopeV1` gains an optional, signed **`authToken`** (bearer `MURMUR-AUTH:…`, appended to the canonical payload only when present → byte-identical back-compat when absent); `@murmurv2/federation` `authorizeInbound` verifies it and binds `subject === senderAgentId`; `@murmurv2/broker-nats` enforces at ingress via an injected `InboundAuthorizer` hook behind `MURMUR_ENFORCE_AUTH` (default OFF, NACK `auth-rejected:<reason>`, never delivered). *Daemon end-to-end wiring pending (see Unreleased).*
- **Conformance suite — extended to every wire type.** `PresenceFrameV1`, `SignedPresenceFrameV1`, `StreamStart`/`StreamChunk`/`StreamEnd` (+ a discriminated `StreamFrame` `oneOf`) added to `protocol-v1.schema.json` and to schema↔runtime-guard agreement matrices; new structural guards `isStreamStart`/`isStreamChunk`/`isStreamEnd`/`isStreamFrame`.
- **Versioned protocol spec.** `docs/protocol-v1.md` (prose lifecycle for envelope, discovery, streaming) + `docs/protocol-compatibility.md` (field tables + per-type validation entrypoints + runtime-only-checks boundary) covering all wire types.

### Changed

- **`stableEnvelopePayload` centralized** into `@murmurv2/core` as the single canonical signing form (was byte-identically copy-pasted across 7 sites: mcp-server, daemon, bridge-a2a, shell-send, demos, agent-runner example, federation live test). Golden-locked by test.

### Fixed

- De-flaked the `mcp-request-reply` C2 long-poll-timeout test (real-timer boundary race → injectable fake clock).

### Validated

- **Real cross-host A2A.** A fresh Murmur agent deployed on Phoenix/agent-hq over the **published** `@murmurv2/*` packages connected to the live broker over Tailscale and exchanged **bidirectional** encrypt/verify/ACK messages with JARVIS — exercising the mesh across real hosts and network (closes the "real mesh deploy" mechanism gate; a second real partner *org* for federation remains an external gate).

## [2.2.0] - 2026-06-22

### Added

- **Published on npm.** All `@murmurv2/*` packages are public on the npm registry @ `0.1.0` (MIT), under the `murmurv2` org. Publish tooling: `scripts/prep-publish.mjs` (private→public, license, `publishConfig`, intra-workspace `file:`→`^0.1.0`, per-package `prepack` build guard, `files: dist/src + LICENSE`) and `scripts/publish-all.mjs` (root build → topological order → per-tarball assertion that `dist/src/index.{js,d.ts}` exist → publish). `@murmurv2/broker-ws` ships in the next release.
- **WebSocket transport adapter** — `@murmurv2/broker-ws`: relay server + broker client with envelope delivery, ACK correlation, dedupe, and invalid-envelope NACKs, reusing the core primitives. Browser/edge deployment examples pending.
- **Roster-backed auth tokens** — `@murmurv2/federation`: `signAuthToken`/`verifyAuthToken` issue Ed25519-signed tokens with audience, scopes, and `nbf`/`exp` windows; the issuer verify key is resolved from the verified roster (no embedded trust root).
- **`RosterStore`** — `@murmurv2/federation`: pinned-key trust + monotonic-version replay guard (rejects stale/downgraded rosters) + trust-epoch reset on key rotation.
- **Machine-readable protocol schema + conformance** — `@murmurv2/core/schema/protocol-v1.schema.json` (Draft 2020-12; root validates `EnvelopeV1`, `#/$defs/AckV1` for acks) + `docs/protocol-compatibility.md` matrix; the conformance suite asserts the schema and `isEnvelopeV1` agree on every accept/reject.
- **Federation live interop (in isolation)** — cross-org sealed+signed delivery proven over real NATS accounts and a leaf-node topology with least-privilege publish/subscribe boundaries (`packages/federation-nats/integration/`); a NATS accounts-config renderer generates each org's account contract.
- **ACP autonomy loop** — idempotent Murmur→ACP task producer + a gated send-boundary worker client.

### Changed

- README, file tree, and Roadmap synced to the real state, with honest scoping for in-isolation / mock-counterpart features.

## [2.1.0] - 2026-06-21

### Added

- **JetStream durability (opt-in).** Optional NATS JetStream durable consumers behind the existing broker/outbox interface — finite `max_deliver` (default 5) + `ack_wait` (default 30s), automatic repair of drifted consumers, retryable-failure `nak()` for broker redelivery, and poison-message terminal ACK. Default-OFF; enable with `MURMUR_JETSTREAM=1` or `config.jetstream.enabled`. The SQLite outbox remains the transactional source of truth.
- **JetStream advisory → DLQ.** `startJetStreamAdvisoryDlq` routes `MAX_DELIVERIES` / `MSG_TERMINATED` advisories to the outbox dead-letter sink.
- **Federation (cross-org).** New `@murmurv2/federation` — `org/agentId` addressing (bare id ⇒ local org) and an Ed25519-signed per-org key directory (roster) — and `@murmurv2/federation-nats` — NATS leaf-node / per-org account `fed.*` subject contract with subject-safe token encoding and account export/import isolation. Payload stays E2E-opaque across federation.
- **A2A bridge skeleton.** `@murmurv2/bridge-a2a` terminates the industry-standard A2A protocol (`@a2a-js/sdk`) and re-wraps tasks as internal Murmur E2E envelopes.
- **Native wake self-heal.** Codex app-server wake threads are re-seeded automatically when missing/stale; WS-over-UDS transport for the Codex app-server.

### Changed

- Wake/notify runtime no longer routes through OpenClaw or tmux persistent injection; native Claude/Codex wake plus Telegram notify are the supported paths.

### Security

- `verifyRoster` verifies a federation roster against a caller-pinned org key, not the roster's own embedded key — prevents an attacker from publishing a self-signed forged roster.

## [2.0.0] - 2026-06-20

### Added

- `murmur_request` send-and-wait tool for synchronous request/response over NATS.
- Mandatory WakeMonitor with deduplication, loop-breaker, audit-gate, and drain guards.
- WakeMonitor stateless and persistent wake modes.

### Fixed

- ACK routing now targets the original sender, not the consumer.
- Reconnect resilience defaults for long-running NATS clients.

### Changed

- Transport documentation now reflects core NATS plus SQLite outbox behavior without claiming JetStream durability.
- Security bump: `ws` upgraded to 8.21.0.

## [0.2.0] - 2026-03-26

### Added

- Deduplication by sender + conversationId + msgId with max 3 attempts before dead-letter ([109f27f])
- Bidirectional Murmur -- auto-reply OpenClaw responses via NATS ([2cc2d41])
- Observatory dashboard with 3D visualization ([58bf271])
- Bridge inbound Mur-Mur messages into OpenClaw sessions ([960b1d0])
- Operations guide covering queues, retry policy, and troubleshooting ([e302a83])

### Fixed

- Murmur resilience -- OpenClaw fallback + WAL busy_timeout ([5bd0e80])
- Rewrite on-receive-openclaw.mjs to use CLI instead of broken cron tool ([aaec353])
- Dead-letter on 400 responses + truncate Telegram messages over 4000 chars ([4324488])
- Bridge timeout increased to 120s, atomic claimDue, flush mutex ([a3d95ad])

### Changed

- NATS keepalive: 30s ping interval, infinite reconnect, named connections ([b67d64b])

## [0.1.0] - 2026-02-11

### Added

- Durable unified notify queue with quick init presets ([e7069d0])
- Invite-based peer setup -- 3 commands, zero JSON editing ([6a60294])

[Unreleased]: https://github.com/alexfrmn/murmur/compare/v2.11.0...HEAD
[2.11.0]: https://github.com/alexfrmn/murmur/compare/v2.10.0...v2.11.0
[2.10.0]: https://github.com/alexfrmn/murmur/compare/v2.9.0...v2.10.0
[2.0.0]: https://github.com/alexfrmn/murmur/compare/v0.2.0...v2.0.0
[0.2.0]: https://github.com/alexfrmn/murmur/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alexfrmn/murmur/releases/tag/v0.1.0
