# Setup engine and CLI contract (work in progress)

This is the implementation-side mapping for the consumer-owned
`spikes/windows-tray-go/CONTRACT.md` at `21d916d`. No UI infers successful delivery
from process liveness. Commands write JSON to stdout, diagnostics to stderr, and
exit 0 for a formed response even when its measured state is bad.

## Paths and adapters

Shared exports: `packages/setup/src/types.ts`. Darwin uses
`import type { PlatformAdapter, ServiceContext } from "../types.js"`.
All context paths are absolute. `configPath` is `dataDir/agent-config.json`,
`storePath` is `dataDir/murmur.db`, and **the only setup log directory is
`dataDir/logs`**. Conflicting derived paths are rejected before service changes.
No automatic migration or relabeling of existing legacy paths.

Default data directory: Linux `$XDG_STATE_HOME/murmur` or
`~/.local/state/murmur`; macOS `~/Library/Application Support/Murmur`;
Windows `%LOCALAPPDATA%/Murmur`. Explicit `--data-dir` selects an entire contour,
including logs and read/proof state. Relative overrides are rejected, never
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
| `outbox.pending`, `inflight`, `delivered`, `failed`, `dlq` | integer or null | SQLite: pending/sent/acked/failed/dlq respectively |
| `outbox.oldestPendingAt` | RFC3339 or null | pending/sent/failed rows in same transaction |
| `outbox.lastError`, `lastErrorAt` | stable reason/RFC3339 or null | nonempty outbox last_error and updated_at |
| `deliveries` | array or null, newest 20 | durable inbox/outbox rows, not broker publish success |
| `wake.enabled`, `mode`, `responder` | boolean/consumer enums or null | fresh daemon observation; custom hook identity is unknown unless declared |
| `wake.storedOnly` | integer or null | terminal stored-only rows; mode information, no color effect |
| `wake.pendingUndelivered` | integer or null | pending/inflight/failed durable wake rows; paused rows remain visible |
| `wake.lastDeliveredAt` | RFC3339 or null | handled rows only, not stored-only/transport timestamps |
| `wake.lastFault`, `lastFaultAt` | stable reason/RFC3339 or null | failed/DLQ wake records in SQLite |

### Independent measurements

`measurements` on a section maps source names to `{ measuredAt, unknownReason }`.
For example wake has `store` and `runtime`, inbox has `store` and `cursor`.
A failed runtime read never erases measured queue counters. Section `unknownReason`
is a backward-compatible summary naming the unavailable source, not a claim that
all fields are unmeasured. Null in a historical-error field means no recorded
failure only when that field's source measurement succeeded.

### Pair proof

`paired=true` requires a nonce challenge and authenticated response from the exact
peer identity, bound to the current local/remote signing and encryption key
fingerprints. A matching local config, a decoded reply blob, a process, a NATS
connection, or an unsigned ACK never establishes mutual pairing. A proof expires
in 24 hours, immediately on identity/key changes, or on explicit invalidation.
Without proof the answer is null; a measured mismatch is false. Doctor without a
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
