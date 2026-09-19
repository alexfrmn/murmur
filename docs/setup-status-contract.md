# Setup engine and CLI contract (work in progress)

This is the implementation-side mapping for the consumer-owned
`spikes/windows-tray-go/CONTRACT.md` at `78b40c4605f421a2d6bc8435846066fa953ff51c`. No UI infers successful delivery
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
Windows `%ProgramData%/Murmur` for the service installation, shared by CLI/service/tray
regardless of their account. A standalone Windows daemon uses explicit `--data-dir`,
not a second implicit profile path. The installer grants SYSTEM and the designated
interactive account access to private state; readable logs must not make private
keys readable by all Users. Explicit `--data-dir` selects an entire contour,
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
| `outbox.queue.pending`, `inflight`, `delivered`, `failed`, `dlq` | integer or null | SQLite: pending/sent/acked/failed/dlq respectively |
| `outbox.queue.oldestPendingAt` | RFC3339 or null | pending/sent/failed rows in same transaction |
| `outbox.faults.lastError`, `lastErrorAt` | stable reason/RFC3339 or null | nonempty outbox last_error and updated_at |
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

## Source checkout CLI

After `npm ci && npm run build`, run `node packages/setup/bin/murmur.mjs`.
Supported now: `status --json`, `doctor --json [--peer AGENT] [--timeout MS]`, `logs path --json`,
`clients detect`, `service install|start|stop`, `wake pause|resume [--apply]`, and
`inbox mark-read`. Every command accepts absolute `--data-dir` and optional
`--service-name`. Status/doctor form JSON even for a missing configuration or
stopped service. Unknown CLI arguments fail without a fabricated status.

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
into the selected `dataDir/logs`. Windows adapter integration remains pending in
this engine revision and is explicitly unknown, not reported stopped/healthy.
The package is private and depends on a built source checkout; this is not an npm
installation or an end-user release. Init/invite/join and client config writing
are a subsequent integration slice, not claimed implemented here.

Runtime wake faults combine durable SQLite failure records with a fresh PID/store
bound daemon observation. The daemon records stable codes for monitor crashes,
including database-lock crashes that cannot update their own SQLite delivery row.
The runtime observation contains no command output or message bodies.
