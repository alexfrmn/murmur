# Native Wake-On-Message (tmux-Free, OpenClaw-Free)

Murmur wakes agents on new messages using each CLI's **native** mechanism: no
`tmux send-keys`, no OpenClaw bridge, no polling daemon. Human notification stays
on the Telegram bot (`notify_queue`).

## Pausing wake and shell hook failures (#156)

`wake.enabled: false` pauses dispatch from both inbound notifications and the
daemon's periodic drain. Pending rows keep their status, attempts and cursor;
already dispatched hooks may finish. Re-enabling resumes the saved backlog under
the existing concurrency, batching and loop-breaker limits. This is a pause, not
a discard: inspect the backlog before enabling a long-idle agent, since it may
produce a burst of wakes (or loop-breaker mutes). Config changes take effect when
the daemon reloads/restarts; no shared broker restart is needed.

`wake.hookTimeoutMs` sets the timeout for both `onReceive` and `proxyOnReceive`
shell hooks (default 10000 milliseconds; positive integer, at most 2147483647).
An unsuccessful exit, timeout, or shell spawn error is a failed wake. For the
durable inbound monitor it follows the configured retry/backoff and DLQ policy;
it never becomes `handled`. The legacy proxy monitor has no durable queue, so
its failures are logged without durable retry. Error records contain a stable
failure code rather than the shell command or captured output.

With no responder configured, the durable row settles as `stored-only` with
`wake-no-responder`. This terminal state proves persistence only, not wake or
agent handling. It is excluded from automatic retries, including after a
responder is configured later. The additive status needs no table migration;
operators can still retrieve the message from the inbox.

## Optional Codex wake batching (#124)

The daemon uses `turn/start`, never `turn/steer`. By default every message keeps its
own turn in the existing serial lane. Opt in for an individual native peer:

```json
{
  "wake": {
    "peers": {
      "agent-example": {
        "mode": "codex_app_server",
        "steer_batch_window_ms": 250,
        "steer_max_per_turn": 10
      }
    }
  }
}
```

The option names come from the original issue's steer terminology. The window is
a quiet period (0–60000 ms); the limit is 1–100 messages (20 if only the window is
configured). While a turn runs, later messages stay queued. At the turn boundary,
up to the limit are sent in one subsequent turn; excess messages remain FIFO for
later turns and the dispatch log includes the remaining count. Quiet windows do
not block other lanes. Only the same peer, conversation, channel, sender member
and addressee can share a batch, even when a peer pins one thread for all channels.

Batching requires the durable message store. Startup fails with
`wake-batching-requires-durable-store` if it lacks `assignWakeBatch`,
`getWakeBatch` or `settleWakeBatch`; an in-memory-only batch is never enabled.
Every message passes the existing
receive eligibility, audit and ownership gates before its text can enter the batch.
The loop breaker counts actual wake effects, so one batch counts once. Rows remain
pending during the quiet window; a crash there loses no messages. Before dispatch,
membership is persisted in the same SQLite database under a deterministic batch ID.
Retries and daemon restarts keep that ID (including the relay's deduplication key),
and new arrivals cannot join an already attempted batch. All members share one
retry deadline and terminal decision, using the highest prior attempt count. The
outcome commits in one transaction, so a restart cannot observe a split batch.
If a member of a saved batch no longer passes its gates, the remaining members are
muted with `batch-member-ineligible`; its content is never replayed using another
member's permission. The batch and original message IDs appear in dispatch logs.

Rollout: upgrade and test with batching omitted, enable it for one peer, verify
normal/overflow/failure behavior, then expand. Rollback: drain pending batches,
remove both peer options, and retain the additive `wake_batch_id` column. Existing
saved batches retain their grouping while the upgraded daemon drains them.

## Claude Code - `asyncRewake` Hook

`scripts/wake-drain-claude.sh` reads new inbound messages from the daemon's
SQLite store (`local_messages`). Run as a Claude Code hook with
`asyncRewake: true`: a non-empty result prints to stderr and exits `2`, and
Claude Code wraps the output in a `<system-reminder>` and wakes the idle session.
A cursor file (`MURMUR_WAKE_CURSOR`) makes each message wake exactly once.

Register it out-of-the-box in the agent's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "/path/to/scripts/wake-drain-claude.sh", "asyncRewake": true }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "/path/to/scripts/wake-drain-claude.sh", "asyncRewake": true }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/path/to/scripts/wake-drain-claude.sh", "asyncRewake": true }] }]
  }
}
```

Env:

- `MURMUR_DB`: daemon SQLite store path (default `.data/murmur.db`, relative to the
  working directory — set it explicitly when the hook runs from elsewhere).
- `MURMUR_WAKE_CURSOR`: cursor file. Defaults to one file **per session**,
  `~/.murmur-wake-cursor-<session>`.
- `MURMUR_WAKE_SESSION_KEY`: overrides the session key (first 8 chars of
  `CLAUDE_CODE_SESSION_ID` otherwise).

Drain semantics:

- Only `local_messages.direction='inbound'` rows are surfaced.
- One cursor per session, so a message wakes **every** live session rather than only
  whichever one reached the hook first. Within a session the hook and the cold-idle
  watcher share the key, so it still wakes exactly once.
- The first run in a new session seeds the cursor to the current tip and stays silent:
  without that, a fresh session would replay the whole inbound history as "new".
- The cursor advances to the last **reported** `rowid`, never to the table's tip: a row
  inserted mid-drain would otherwise be stepped over and never wake anyone.
- Cursor writes use a temporary file plus rename where the filesystem allows it.

### Windows / no `sqlite3` CLI — `wake-drain-claude.mjs`

`wake-drain-claude.sh` shells out to the `sqlite3` CLI, which is not installed
by default on Windows (the daemon uses `node:sqlite`, not the CLI). There the
query returns empty, the hook exits `0`, and the session is never woken — native
wake silently looks broken.

`scripts/wake-drain-claude.mjs` is a dependency-free node port that reads the
store via `node:sqlite`, so it runs anywhere node does. It also polls (up to
`MURMUR_WAKE_MAX_SECONDS`, single-poller lock) so a message that arrives while
the session is already idle still wakes it, which a one-shot Stop hook cannot.
Run it under `node --no-warnings` and register the same way:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node --no-warnings /path/to/scripts/wake-drain-claude.mjs", "asyncRewake": true }] }]
  }
}
```

Same env and the same per-session cursor as the shell version (`MURMUR_DB`,
`MURMUR_WAKE_CURSOR`, `MURMUR_WAKE_SESSION_KEY`) plus `MURMUR_WAKE_LOCK`,
`MURMUR_WAKE_MAX_SECONDS`, `MURMUR_WAKE_POLL_MS`. Pass `--once` for a single
non-polling check (e.g. a PostToolUse hook). Requires Node with `node:sqlite`
(22.5+).

A fault — no store, an unreadable store, no `node:sqlite` — prints one line to stderr
and exits `0`. Exiting non-zero would wake the session with a false alarm; exiting
silently is the failure this port exists to remove, so it does neither.

### Cold start: what arrived while nothing was listening

The cursor is per session. That is what makes a message wake every live session
instead of only the first one to reach the hook — but it also means a brand-new
session has no cursor and seeds its baseline at the current tip. Anything that
landed while no session was alive is then skipped by every session that follows.

`--session` closes that gap. It reads a **shared** anchor
(`MURMUR_WAKE_ANCHOR`, default `~/.murmur-wake-anchor`) that records how far the
contour as a whole has been drained, reports what came in past it, and moves the
anchor forward. Register it on `SessionStart`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node --no-warnings /path/to/scripts/wake-drain-claude.mjs --session" }] }]
  }
}
```

It writes to **stdout** and exits `0`, because a `SessionStart` hook feeds its
stdout to the session as context — there, exit `2` means "block", not "wake".
With no anchor on disk (fresh install, or an upgrade from a build without one)
it adopts the tip and stays quiet rather than replaying the whole store. Output
is capped at `MURMUR_WAKE_SESSION_MAX` messages (default 20); anything older is
counted, not printed. The anchor only ever moves forward, so a stale writer
cannot make a delivered message look undelivered.

Only the node port has this mode; `wake-drain-claude.sh` still has `poll` and
`--once` only.

### Filtering what the drain wakes on — and what that costs (#146)

Both drains accept an optional local filter. It is **off by default**: with no
`MURMUR_WAKE_SKIP_*` set, every inbound row is reported exactly as before.

| Env | Effect |
|---|---|
| `MURMUR_WAKE_SKIP_SENDERS` | comma-separated sender ids not to wake on |
| `MURMUR_WAKE_SKIP_CONVERSATIONS` | comma-separated conversation ids not to wake on |
| `MURMUR_WAKE_SKIP_INELIGIBLE` | `1` to also skip rows the daemon marked `wake_eligible=0` |
| `MURMUR_WAKE_SKIPPED_LOG` | append-only JSONL ledger of skipped rows (default `~/.murmur-wake-skipped.jsonl`) |

**The cursor rule.** The cursor may only ever pass a row the drain actually looked
at, and the high-water mark it moves to comes from the same `SELECT` that produced
the rows — never from a second `MAX(rowid)` query. Break that and messages are lost
permanently and silently, in two ways: a row landing between the two queries is
stepped over and reported by nobody, and any row removed by a filter ends up below
the new cursor, where no future drain will select it again.

So a filter here does not drop a row, it **records** it. Every deliberately skipped
row is appended to the ledger — `{"ts","rowid","sender","conversationId","reason","cursor"}`
— *before* the cursor moves past it, and if the ledger cannot be written the cursor
stays put so the rows are selected again next run. "Skipped" and "never happened"
stay different things.

Hand-editing the drain's `WHERE` clause to exclude a peer or a conversation is the
same defect with the ledger removed: the excluded rows go below the cursor and are
gone. Use the env filters instead.

### A new lane is deaf until its first turn

The poller is started by the `Stop` hook, and `Stop` fires at the end of a turn.
A session that has just started has not taken one, so the poller is not running
and inbound messages do not wake it — even though `SessionStart --session` ran
and seeded the anchor, which makes the wake path look fully wired (#130). For an
autonomous install this is the normal state after every reboot or watchdog
restart, not an edge case.

Give the lane one priming turn after launch: the watchdog sends a harmless
prompt right after starting the session, purely to produce a first `Stop`. In
tmux, send the text and `Enter` as two separate `send-keys` calls — in one call
the prompt is typed but never submitted.

### No responder configured is a state, not a silence (#146)

A daemon with neither `onReceive` nor `wake.peers[<id>].mode = "codex_app_server"`
accepts, decrypts, stores and ACKs every message exactly like a healthy one. The
only difference shows up when somebody waits for a reply nobody was going to write.

Two places now say so out loud:

- **Startup.** `Daemon ready` carries `wake: { configured, hook, native, nativePeers }`,
  and a zero-responder daemon logs `No wake responder configured` at `warn` before the
  first message arrives. The `agentId` and `peers` fields are unchanged.
- **Per message.** `WakeMonitor: hook not configured, message stored only` at `warn`,
  with `msgId` and `conversationId`. It replaces `WakeMonitor hook completed`, which
  used to be printed whether or not a hook existed — a log in which a working contour
  and a contour with no responder at all were byte-identical.

## Codex CLI - App-Server WS-over-UDS

Codex is woken over the `codex app-server` WebSocket protocol on a Unix-domain
socket (`--listen unix://...` or managed remote-control socket): the daemon acts
as a WebSocket client, sends the app-server `initialize` handshake, and then
issues `turn/start` on the live thread when a Murmur message arrives. This
replaces the old `codex-murmur-watch` polling path.

Codex runtime facts verified against Codex CLI `0.141.0`:

- `codex app-server --help` is present.
- `--listen unix://PATH` and `--remote unix://PATH` are supported.
- `codex remote-control start --json` is idempotent and returns
  `.daemon.socketPath`.
- `codex app-server generate-ts --experimental` exposes JSON-RPC method
  `turn/start` with `TurnStartParams { threadId, input }`.

Configure a Codex peer as an app-server wake target:

```json
{
  "wake": {
    "peers": {
      "agent-jarvis": {
        "mode": "codex_app_server",
        "socketPath": "/home/codexworker/.codex/app-server.sock",
        "threadId": "thread-id-of-live-codex-session"
      }
    }
  }
}
```

The daemon connects with a `ws+unix://SOCKET:/` client URL. It first sends:

```json
{
  "id": "init-1",
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "murmur-codex-app-server-wake" },
    "capabilities": { "experimentalApi": true, "requestAttestation": false }
  }
}
```

After the app-server responds, the daemon sends `initialized` and then:

```json
{
  "id": 1,
  "method": "turn/start",
  "params": {
    "threadId": "...",
    "input": [{ "type": "text", "text": "[MURMUR WAKE]...", "text_elements": [] }]
  }
}
```

If the Unix socket or live `threadId` is absent, wake fails loud in daemon logs
instead of silently falling back to polling.

The previous `persistent` tmux backend has been removed from the wake path.
Native wake modes are `stateless` shell hooks and `codex_app_server`.

### Codex Desktop on Alex's Mac

Alex's Mac uses a LaunchAgent-managed `codex app-server` as a headless wake
target for the Desktop thread. Because that hidden turn cannot safely write the
Murmur SQLite store from its sandbox, the daemon relays the hidden turn's final
answer back through Murmur when `relayFinalToMurmur=true`.

Operational details, paths, verification commands, and the last known good
message IDs are in [`docs/codex-mac-wake-relay.md`](codex-mac-wake-relay.md).

### Codex Autostart Sequence

> **Diagnostic / opt-in only.** This sequence only covers
> app-server-managed Codex sessions launched with `--remote`. It is not a
> community-grade native wake solution: plain `codex` and desktop-launched Codex
> sessions are not covered because Codex app-server instances are isolated per
> client and currently do not talk to each other. Keep issue #25 open for the
> real product goal. The strategic community-grade path is MCP-channel wake:
> MCP custom notification -> active-session user submission through a supported
> `[mcp_servers]` configuration surface.

Autostart belongs in the Codex launcher wrapper, not in the Murmur daemon. The
launcher owns the live TUI process and is the only layer that can know which
session thread was just attached.

1. Start or attach the managed app-server before launching the TUI:

   ```bash
   codex remote-control start --json
   ```

   Parse `.daemon.socketPath` from stdout. Current Codex `0.141.0` returns a
   shape like:

   ```json
   {
     "status": "connected",
     "daemon": {
       "status": "alreadyRunning",
       "socketPath": "/home/codexworker/.codex/app-server-control/app-server-control.sock"
     }
   }
   ```

2. Launch the interactive session against that socket:

   ```bash
   codex --remote "unix://${CODEX_APP_SERVER_SOCKET}" "$@"
   ```

   For the vault launcher, this belongs in the session startup entrypoint that
   wraps the real Codex process, not in `codexx` if that wrapper is intentionally
   kept as a dumb `cd && exec codex "$@"` launcher.

3. Capture the live `threadId` automatically after the remote session starts.
   Codex writes session JSONL under
   `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. The first line is a
   `session_meta` event; use `.payload.id` as the app-server `threadId`. The
   same UUID is embedded in the rollout file name, but the JSONL field is the
   stable capture point.

   Launcher implementation sketch:

   ```bash
   session_file="$(ls -t "$CODEX_HOME"/sessions/*/*/*/rollout-*.jsonl | head -n 1)"
   thread_id="$(head -n 1 "$session_file" | jq -r 'select(.type=="session_meta") | .payload.id')"
   ```

   A production launcher should filter by launch timestamp and current `$PWD`
   (`.payload.cwd`) before accepting the file, so parallel Codex sessions do not
   race the capture.

4. Wire the Codex peer in the agent config before daemon restart:

   ```json
   {
     "wake": {
       "peers": {
         "agent-jarvis": {
           "mode": "codex_app_server",
           "socketPath": "/home/codexworker/.codex/app-server-control/app-server-control.sock",
           "threadId": "019ee8b4-382a-76c3-a266-16056dc6108b"
         }
       }
     }
   }
   ```

   For the Codex worker deployment, the target file is
   `.data-codex-volt/agent-config.json`. Update it atomically: write a temporary
   JSON file, validate it with `jq empty`, then rename over the old config.

5. Restart the Murmur daemon after the config write:

   ```bash
   sudo systemctl restart murmur-daemon
   ```

   If the daemon is run directly instead of systemd, stop the old process and
   start `node scripts/murmur-daemon.mjs` with the same `DATA_DIR` and
   environment. The daemon reads `wake.peers` only at startup.

With those five steps in the launcher, a new Codex session brings up remote
control, captures its own app-server thread, wires Murmur wake routing, and
restarts the daemon without a manual copy/paste step.

## Delivery semantics: one wake per delivery (#105)

The daemon's wake path is exactly-once on the receiving side. What that means in
practice, and where each guarantee lives:

- **The `msgId` is the delivery id.** It is minted once when the envelope enters the
  sender's outbox and never changes across retries, so every copy of a redelivered
  message — JetStream redelivery, a sender's ACK-timeout resend, a 2.6.0 storm —
  carries the same id.
- **One row per delivery.** `local_messages` stores `delivery_id` (`inbound:<msgId>`)
  under a UNIQUE index. `append` runs the existence check and the insert in one
  transaction and reports `duplicate: true` when the row was already there. The daemon
  then ACKs — the delivery did succeed — and starts no second wake.
- **ACK means stored, not woken.** The daemon returns to the broker as soon as the row
  is committed; the wake itself runs off the durable queue. Before 2.9 the sender's ACK
  (and JetStream's `ack_wait`) waited for the whole Codex turn, which is how a slow turn
  produced a resend of the very message it was answering.
- **The wake state lives on the row.** `wake_status` moves
  `pending → inflight → handled | failed | muted | dlq`. A claim is an UPDATE whose WHERE
  clause is the lock: only a pending or due-for-retry row flips to `inflight`, so a
  duplicate that arrives while the first copy is being processed, or after it was
  handled, is refused durably.
- **A failed wake is retried under the same delivery id**, with exponential backoff
  (`wake.retry.backoffMs`, default 30 s, doubling to `backoffMaxMs`, default 10 min),
  up to `wake.retry.maxAttempts` (default 5). After that the row is dead-lettered and
  the fallback notifier fires with reason `wake-dlq`. An error flagged
  `retryable: false` dead-letters on the first attempt.
- **The cursor never skips a gap.** It is not a counter the monitor bumps; it is the
  highest inbound row such that every inbound row at or below it is settled, read back
  from the table after every change. A restart resumes from the rows, not from the
  table tip: rows left `inflight` by a dead process return to the queue as failed-and-due.
- **The relay is idempotent.** For `relayFinalToMurmur` peers the reply's `msgId` is
  derived from the inbound `msgId` (`deriveRelayReplyMsgId`), and `murmur-shell-send`
  accepts it via `--msg-id`. On a retry the injector first checks the peer's outbox for
  that id; if the previous attempt already queued the reply, the turn is **not** started
  again and the delivery is settled with `source: "relay-idempotent"`.
- **An empty final answer is not a relay** (#106). A turn that completes with nothing to
  send fails the wake with `codex-app-server-final-empty:<turnId>:<source>` (not
  retryable) instead of logging `wake final relayed` with a null reply.

Upgrading is silent: the new columns are added with `ALTER TABLE`, rows written before
this release keep a NULL `delivery_id` and NULL `wake_status` — outside the queue, never
replayed — the same seeding rule `wake-drain-claude` applies to a fresh cursor.

### Turn outcome, lanes and thread memory (#106, #107, #108)

- **A turn's status is checked, not assumed** (#106). `turn/completed` carries
  `turn.status` (`completed | interrupted | failed | inProgress`) and `turn.error`; the
  client now surfaces both. A `failed` turn fails the wake as
  `codex-app-server-turn-failed:<turnId>:<error>` and is retried under the same delivery
  id; an `interrupted` turn (someone stopped it on purpose) fails as
  `codex-app-server-turn-interrupted:<turnId>` and is not retried. Neither is relayed.
- **Wakes run in lanes** (#107). `WakeMonitor` used to be one sequential loop: a long
  turn for one peer held every other inbound message until it finished or timed out. It
  now dispatches into lanes — one per (peer, conversation), or one per peer for a Codex
  peer pinned to a static `threadId` — and runs up to `wake.concurrency` lanes at once
  (default 4; `1` restores the old behaviour). Within a lane order is kept and nothing
  overlaps; across lanes a short question no longer waits behind a long turn.
- **Codex threads are remembered per (peer, conversation)** (#108). Without a static
  `threadId`, the injector used to seed a thread and write its id into `peer.threadId` —
  one thread per peer for the life of the process, gone on restart. Threads are now keyed
  by peer *and* conversation and stored in `wake_threads` in the message store, so a
  daemon restart resumes the same Codex thread and two conversations from one sender no
  longer share context. A static `peer.threadId` remains an explicit pin for every
  conversation; when a pinned thread is gone (`thread not found`) the re-seeded thread is
  remembered together with the pin it replaced, so changing the pin in config wins over
  the remembered thread.

```json
{
  "wake": {
    "concurrency": 4,
    "retry": { "maxAttempts": 5, "backoffMs": 30000, "backoffMaxMs": 600000 }
  }
}
```

## Scoped Channels & Session Affinity

The Codex autostart sequence above documents a real open problem: app-server
instances are **isolated per client**, so a naive wake can fire the wrong
session — or, when an agent has several sessions open, *every* session reacts to
the same message (double-emit) and the daemon spawns a **competing thread**
alongside the one a human is already attending. Native wake alone has no notion
of which session "owns" the conversation.

Scoped Channels closes that gap with a DB-backed **session-ownership lease**. For
an addressed conversation, exactly one session of the addressed agent holds the
lease; only that session emits, and every other session — and the native daemon
wake — stays silent.

**Lease store.** `SessionLeaseStore` lives in its own SQLite file with a separate
WAL from `local_messages` (tables `channel_owner` + `session_presence`):

- `claim_or_skip` — atomic single-statement compare-and-swap
  (`INSERT … ON CONFLICT(conversation_id, member_slot) DO UPDATE … WHERE stale OR
  same_session`, `token = token + 1 RETURNING token`). The caller that gets a
  token owns the channel; everyone else skips.
- `heartbeat` — keeps a held lease alive without bumping the token.
- `isCurrentToken` — a per-turn fencing token, re-checked at outbound, so a
  resurrected/raced session can't emit under a stale claim.
- `registerSession` / `hasLiveInteractiveSession` — the presence registry the
  wake gate consults.
- `preemptPrefix` (optional) — lets a real interactive chat session reclaim a
  channel from a fallback owner.

**Wake becomes a presence-deferring, lease-gated fallback.** `createNativeLeaseGate`
is injected into `WakeMonitor` as `leaseGate`. Before waking, the daemon checks
session presence:

- a **live interactive session** exists for the agent → the daemon wake
  **defers** (it does *not* spawn a competing thread; the attended session
  handles the message);
- **no** live session → the daemon claims the lease and performs the **cold-wake**
  fallback, exactly as native wake does today.

**One claim across every delivery path.** Foreground-push, cold-start, and
in-session MCP-channel delivery all follow the same rule: claim before any
side-effect, fence the outbound by the lease token, suppress non-owners. The
result is live-verified — N delivery sessions for one message resolve to
**exactly one emit**, and the native daemon wake defers to the attended session
instead of spawning a new thread.

**Compatibility.** The whole feature sits behind `MURMUR_SCOPED_CHANNELS`
(default **OFF**). With no lease gate set, `WakeMonitor` behaves exactly as
described in the sections above — scoped channels is purely additive.

## Why not tmux / OpenClaw

- **tmux send-keys** is fragile (races with human typing; `TIOCSTI` disabled on
  Linux 6.2+) and this environment does not use tmux.
- **OpenClaw** as a wake/delivery dependency is non-standard and a community
  minus; native hooks + app-server + Telegram are standard and dependency-free.

Prior art: `ExaDev/agent-comms`, `cocodrino/bridge-harness` (asyncRewake + NATS),
`synadia-ai` NATS Agent Protocol.
