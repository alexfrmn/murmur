# Codex Desktop Exact-Task Delivery

Murmur can deliver an inbound message to the exact visible Codex Desktop task
that originated the conversation. This path uses the Desktop app's shared local
`codex queue` command; it does not start a headless app-server turn or create a
new task.

This integration is macOS-only and opt-in. It was tested with the Codex binary
bundled in ChatGPT Desktop (`codex-cli 0.150.0-alpha.8`). Unsupported Codex
versions fail closed: the message remains in Murmur's local store and the wake
hook reports a queue failure.

## Routing Contract

When the MCP server runs inside a Codex task, Codex sets `CODEX_THREAD_ID`.
`murmur_send` and `murmur_request` use the following default conversation id
when the caller does not provide one:

```text
codex:task:<CODEX_THREAD_ID>
```

The receiver accepts only that exact form for Desktop injection. It verifies
that the UUID belongs to a non-archived Desktop user task and that the task
previously initiated a Murmur exchange with the sending peer before invoking:

```text
codex queue --thread <UUID> --message <text>
```

An archived, missing, malformed, legacy `dm:`, or otherwise unaddressed
conversation remains in the Murmur inbox. It may produce a privacy-safe desktop
notification, but it is never redirected into the latest task. This prevents
project-specific work from landing in an unrelated conversation.

An outbound MCP call records the peer/task participation binding under the
private Murmur data directory. The hook also accepts durable local evidence of
an earlier outbound message on the exact task conversation, but only when that
message was acknowledged by the same authenticated peer. This supports older
tasks and sends made through `murmur-shell-send.mjs`, which predate the binding
marker. An inbound message alone never creates this permission, so a peer
cannot opt itself into an unrelated task by sending or guessing a task UUID.
Missing or malformed participation evidence fails closed to inbox-only
delivery.

`conversationId` is local task affinity, not a replacement for Murmur's Phase N
channel roster. Logical agent/member addressing should continue to use
`channelId`, `memberId`, and `memberSlot` as that transport and presence wiring
is completed. Enabling that Phase N/N4 metadata is a coordinated mesh migration:
sender, receiver, roster, and wake configuration must move together instead of
introducing a second identity convention in message text.

## Daemon Configuration

Configure the normal Murmur daemon's `onReceive` hook. Use an absolute path and
the same `DATA_DIR` as the MCP server so synchronous request/reply suppression
markers are shared:

```json
{
  "wake": {
    "enabled": true,
    "mode": "stateless"
  },
  "onReceive": "node --no-warnings /absolute/path/to/murmur/scripts/codex-desktop-notify.mjs"
}
```

Optional environment variables:

- `CODEX_HOME`: Codex state directory (default: `~/.codex`).
- `CODEX_STATE_DB`: explicit Codex state SQLite path. Without it, the hook picks
  the highest `state_<N>.sqlite` schema version under `CODEX_HOME`.
- `CODEX_DESKTOP_THREAD_SOURCE`: internal Desktop source label in the Codex
  state database (default: `vscode`).
- `DATA_DIR`: Murmur private data directory (default: `<repo>/.data`).

The hook looks for Codex binaries bundled in `/Applications/ChatGPT.app` or
`/Applications/Codex.app`, then common Homebrew locations.

## Request/Reply Deduplication

`murmur_request` already returns its reply to the waiting tool call. Queueing
the same reply would deliver it twice. The MCP server therefore creates a
private, expiring marker under:

```text
<DATA_DIR>/.codex-request-waits/
```

The receive hook atomically claims and consumes the matching marker and skips
both queue injection and the redundant notification. Marker failure never
blocks Murmur request/reply; it only disables this convenience. Only one
synchronous request per peer and conversation may be outstanding at a time; a
second call fails before sending instead of ambiguously attributing the first
reply to both calls.

## Security Boundary

- The hook never reads or emits NATS credentials or Murmur private keys.
- Message text is passed as an `execFile` argument, not interpolated into a
  shell command.
- Desktop notifications contain the peer id and target task title, not the
  message body.
- A successful queue command is described as queued, not already delivered;
  Codex starts it when the exact addressed task becomes available.
- Auto-delivery is authenticated agent input, not new authorization from the
  desktop owner. The queued prompt states this boundary explicitly.
- A task must have initiated contact with the peer before that peer can inject
  subsequent messages into the task.
- No exact target means no task injection.

## Verification

```bash
npm run build
node --test tests/codex-desktop-notify.test.mjs tests/mcp-request-reply.test.mjs
```

For an end-to-end test, send a request from a Desktop task without an explicit
`conversationId`. The response should retain `codex:task:<UUID>` and appear in
that task. Repeat with `murmur-shell-send.mjs` on the same exact conversation to
cover acknowledged-history migration. A legacy `dm:` test should remain
inbox-only.
