# Setup engine and CLI contract (work in progress)

This maps the implementation to the frozen [setup v1 contract](../contracts/setup/v1/README.md). No UI infers successful delivery
from process liveness. Commands write JSON to stdout, diagnostics to stderr, and
exit 0 for a formed response even when its measured state is bad.

## Paths and adapters

Shared exports: `packages/setup/src/types.ts`. Darwin uses
`import type { PlatformAdapter, ServiceContext } from "../types.js"`.
All context paths are absolute. `configPath` is `dataDir/agent-config.json`,
`storePath` is `dataDir/murmur.db`. Linux and macOS use `dataDir/logs`; the Windows
native helper keeps service logs under `%ProgramData%/Murmur/logs/<serviceName>`. Conflicting derived paths are rejected before service changes.
No automatic migration or relabeling of existing legacy paths.

Default data directory: Linux `$XDG_STATE_HOME/murmur` or
`~/.local/state/murmur`; macOS `~/Library/Application Support/Murmur`;
Windows `%LOCALAPPDATA%/Murmur` (or the user's `AppData/Local/Murmur`).
This private state is separate from public SCM metadata. `DATA_DIR` is canonical;
`MURMUR_DATA_DIR` remains a compatibility alias. Conflicting values fail unless
an explicit `--data-dir` selects the profile. Existing directories are not moved.
A raw daemon/MCP entry invoked outside the CLI still requires explicit `DATA_DIR`.
Explicit profile selection binds identity, database and read/proof state; Windows
service logs remain in their native metadata location. Relative overrides are rejected, never
resolved against an arbitrary launch directory.

## Status: field types and evidence

Every row below is always present. Unknown measurements use null, with a source
reason. Empty collections and zero mean a successful measurement of emptiness.
`generatedAt` is the snapshot acquisition time, not an old cache repainted fresh.

| Fields | Types | Measurement source |
|---|---|---|
| `schema`, `generatedAt` | literal `murmur.status/1`, RFC3339 | schema version, acquisition clock |
| `agentId` | string or null | validated private config |
| `service.state`, `manager` | consumer enums | OS service manager adapter |
| `service.pid`, `since`, `lastExitCode` | integer/RFC3339/integer or null | service manager; PID checked against observed DB fd |
| `service.observedStorePath` | absolute path or null | real process open file descriptor; config/env is insufficient |
| `service.restartCount`, `restartWindowMs` | nonnegative integer or null | measured restart events in the stated interval |
| `service.restartsLastHour` | nonnegative integer or null | only when interval is exactly 3600000ms, never lifetime NRestarts |
| `service.restartFailureThreshold` | integer 5 | engine policy: >=5 restarts in exact hour yields failed/restart-loop |
| `service.lastFailureAt` | RFC3339 or null | measured service event history, otherwise source unknown |
| `broker.url` | URL or null | config without userinfo/token/query |
| `broker.state`, `connectedAt` | consumer enum, RFC3339 or null | fresh daemon observation bound to observed PID/store |
| `broker.lastError`, `lastErrorAt` | stable reason/RFC3339 or null | same daemon observation |
| `peers.list` | array or null | validated config plus proof cache |
| `peers.list[].agentId` | string | local peer identity |
| `peers.list[].paired` | boolean or null | authenticated nonce roundtrip proof, not imported local keys |
| `peers.list[].lastInboundAt`, `lastOutboundAt` | RFC3339 or null | SQLite message history |
| `inbox.total`, `lastAt` | integer/RFC3339 or null | SQLite read transaction |
| `inbox.unread` | integer or null | same transaction plus explicit read cursor; missing cursor is unknown |
| `outbox.queue.pending`, `inflight`, `delivered`, `failed`, `dlq` | integer or null | SQLite: pending/sent/acked/failed/dlq respectively |
| `outbox.queue.oldestPendingAt` | RFC3339 or null | pending/sent/failed rows in same transaction |
| `outbox.faults.lastError`, `lastErrorAt` | stable reason/RFC3339 or null | nonempty outbox last_error and updated_at |
| `outbox.attention` | optional `murmur.outbox-attention/1` object or unknown reason | terminal DLQ metadata plus private local acknowledgements; never message bodies |
| `deliveries` | array or null, newest 20 | durable inbox/outbox rows, not broker publish success |
| `wake.config.enabled`, `mode`, `responder` | boolean/consumer enums or null | validated config; custom hook identity is unknown unless declared |
| `wake.effective.enabled`, `needsRestart`, `observedAt` | boolean/boolean/RFC3339 or null | fresh PID/store-bound daemon observation versus config |
| `wake.delivery.storedOnly` | integer or null | terminal stored-only rows; mode information, no color effect |
| `wake.delivery.pendingUndelivered` | integer or null | pending/inflight/failed durable wake rows; paused rows remain visible |
| `wake.delivery.lastDeliveredAt` | RFC3339 or null | handled rows only, not stored-only/transport timestamps |
| `wake.faults.lastFault`, `lastFaultAt` | stable reason/RFC3339 or null | failed/DLQ wake records in SQLite |

### Independent measurements

The frozen wire shape separates `outbox.queue` from `outbox.faults`, and
`wake.config`, `wake.effective`, `wake.delivery`, `wake.faults`. Each subset has its
own `unknownReason`. In this engine revision both fault subsets read durable
SQLite failure records, not arbitrary stdout; `source` states that evidence scope.
A missing runtime observation never erases measured queue counters. Additional
`measurements` distinguish inbox cursor/store and peer configuration/history/proof.
Null historical errors assert no recorded failure only when the corresponding
source was measured. Runtime-only monitor crashes are a separate observation
source; durable records alone must not be described as complete process history.

### Terminal send warnings (2.11)

An active `outbox.queue.failed > 0` remains red. A terminal DLQ record is a yellow
`outbox.dead-letter` warning, after current service, wake-fault, broker and peer
failures have been considered. This deliberately extends the v1 consumer policy
in TypeScript, Swift and Go together. The 2.11 readiness change below intentionally
updates the pairing-only fixture expectation; other original fixtures are unchanged.
It does not turn an undelivered message into a delivered one.

The Mac profile view shows recipient, original send time and a safe explanation
for each terminal failure. **Dismiss warning** acknowledges exactly that message
and observed failure state; **Restore warning** reverses it. All records remain
in the outbox, and no action sends, retries, deletes or marks them delivered.
A later change to that record invalidates the acknowledgement and warns again.
Metadata is bounded to 200 failures; larger or unreadable sets fail closed.
The view displays 50 at a time, with **Show more messages** to reach older records.

`murmur outbox list --json --data-dir ABSOLUTE` reads only metadata. Mutations are
`outbox dismiss|restore --msg-id ID --expected-state TOKEN --expected-agent AGENT`
with the same profile selection. The token comes from `outbox list` and binds the
exact observed state. A fresh identity/state check precedes the action. Only
private `outbox-attention.json` changes, under the setup lock and the existing
private-file/ACL writer; the database is opened read-only. An absent, malformed,
foreign or inconsistent acknowledgement summary cannot hide a DLQ warning.
Queue totals, delivered totals, historical errors and the inbox cursor stay intact.

### Pair proof

`paired=true` requires a nonce challenge and authenticated response from the exact
peer identity, bound to the current local/remote signing and encryption key
fingerprints. A matching local config, a decoded reply blob, a process, a NATS
connection, or an unsigned ACK never establishes mutual pairing. A proof expires
in 24 hours, immediately on identity/key changes, or on explicit invalidation.
Without proof the answer is null; a measured mismatch is false. In 2.11, the overall
indicator describes measured runtime readiness, not a peer roundtrip or autonomous
wake. A peer with `paired=null` keeps that value and is shown as **Exchange not
checked yet** in the Mac connection card and Windows Connections menu. It no longer
adds a missing runtime field or makes the overall icon grey. `paired=false` still
warns; an empty/unknown peer list, missing runtime measurements, send/wake failures,
broker failures and stale snapshots retain their prior verdicts. Green does not
assert that any peer has replied. Proof expiry/key binding and doctor stages do
not change. The Windows menu shows the first 20 peers and an explicit remaining
count; copy diagnostics retains the complete status. Doctor without a
selected diagnostic peer explains the missing probe instead of silently choosing
an arbitrary recipient. The probe uses existing encrypted signed envelopes; no
wire protocol replacement is introduced.

## Wake pause/resume

`murmur wake pause` and `murmur wake resume` own the config change: backup, atomic
write, and application through the selected local service. Report
`configuredEnabled`, `effectiveEnabled`, `restartRequired`. Effective state is
asserted only after a fresh matching daemon observation. An inaccessible or
unverified service leaves effectiveEnabled null and reports the required action;
it must not claim the daemon paused merely because a JSON file was changed.

The separate stored-only count describes a mode, not failure/success. A paused
queue preserves pending messages and shows that mode explicitly. Doctor always
names missing responders or paused wake, without claiming a successful wake test.
When configured and observed wake are both paused, a backlog alone is yellow
`wake.paused-pending`, with its waiting count and an explicit resume action.
A recorded wake fault stays red, and a pending queue is still red when pause has
not been observed. The Mac resume button saves the setting; it explains the
separate service restart when the daemon has not applied it. Merely opening the
view never resumes wake or replays a backlog.

## Source checkout CLI

After `npm ci && npm run build`, run `node packages/setup/bin/murmur.mjs`.
Supported now: `status --json|--line`, `doctor --json [--peer AGENT] [--timeout MS]`, `logs path --json`,
`clients detect`, `service install|start|stop`, `wake pause|resume [--apply]`, and
`inbox read [--limit 1..100]` plus `inbox mark-read`. Every command accepts absolute `--data-dir` and optional
`--service-name`. Status/doctor form JSON even for a missing configuration or
stopped service. Unknown CLI arguments fail without a fabricated status.

`status --line` is the raw, JSON-free terminal segment documented in
[terminal integration](terminal-integration.md). It returns empty stdout only for
a measured ready runtime with zero unread messages. Unchecked peer proof remains
in the JSON peer details and desktop UI. Unknown, degraded,
and failed measurements always return a fixed visible segment. `inbox read`
returns durable inbound message JSON without changing the read cursor;
`inbox mark-read` is the only CLI operation that advances that cursor.

### Log directory lookup

`murmur logs path --json --data-dir ABSOLUTE [--service-name NAME]` is read-only.
On success it exits zero and returns a separate command schema:

```json
{
  "schema": "murmur.logs/1",
  "agentId": "agent-a",
  "dataDir": "/absolute/canonical/profile",
  "serviceName": "murmur-example",
  "logDir": "/absolute/canonical/profile/logs",
  "source": "configured"
}
```

All six fields are required strings. The identity comes from the validated config
of the selected profile. Both paths are existing absolute realpaths. The log path
must resolve to a readable, traversable directory strictly inside that profile;
an alias to the profile root or another profile is rejected. The command neither
creates directories nor changes permissions, reads log contents, opens the store,
or contacts the service or broker. `source: "configured"` describes the configured
location; it does not prove that a running daemon writes there. Filesystem checks
are observations at invocation time, not protection against later path changes.

A consumer should invoke this command afresh when opening logs, compare `agentId`
with the selected profile's freshly validated status identity, and open only the
returned `logDir`. Failure exits one with empty stdout and a stable stderr code:
`logs.directory-missing`, `logs.not-directory`, `logs.directory-unreadable`,
`logs.path-outside-profile`, or `logs.path-unavailable`. Configuration failures
retain the existing sanitized configuration error behavior. A consumer must not
derive a replacement path or treat a failed lookup as an empty log directory.
This command does not change the frozen status or doctor schemas.

### Other operations

Pause/resume always backs up a changed configuration atomically. `--apply` also
stops/starts the exact managed service; without it the response honestly reports
`restartRequired` and the observed effective mode. Start/stop refuse other profiles
using the same service name. No operation adopts an existing unmanaged service.

Doctor without `--peer` does not send a diagnostic message. With an explicit peer,
it enqueues one encrypted signed nonce challenge through the real daemon outbox,
observes the signed response without ACKing it, and waits for the same response to
be committed to the selected inbox before recording a pairing proof. A timeout
leaves the diagnostic message's normal delivery lifecycle visible in the outbox.
The peer must respond with the exact requested line in the same conversation.
Doctor does not infer intended live-session wake from a transport roundtrip.

Linux uses a per-user systemd unit and Mac a LaunchAgent. Both write stdout/stderr
into the selected `dataDir/logs`. Windows uses the matching `murmur-svc.exe` through
the shared CLI; unavailable or incompatible helpers produce unknown status.
The current `logs path` contract is confined to the profile, so Windows returns
`logs.windows-native-location-unavailable` rather than advertising the wrong folder.
Windows supports explicit `service uninstall`, retaining private data and logs;
the other adapters do not yet implement that operation.

Init/invite/join/add-peer and client configuration are implemented by the shared
engine; see [onboarding](setup-onboarding.md). They run from a built checkout or
prebuilt runtime and do not require published Murmur npm packages. Pairing remains
unknown until doctor proves a persisted signed roundtrip.

Runtime wake faults combine durable SQLite failure records with a fresh PID/store
bound daemon observation. The daemon records stable codes for monitor crashes,
including database-lock crashes that cannot update their own SQLite delivery row.
The runtime observation contains no command output or message bodies.
