# Server link: what the daemon reports when the broker goes away

Issue #276. A Murmur daemon whose NATS connection was lost used to log one `disconnect`
line and nothing after it. The nats.js client kept retrying forever (`maxReconnectAttempts`
is `-1`), but every failed attempt was invisible: no log line, no field in
`daemon-observation.json`, no exit. The process kept its PID, launchd/systemd showed a
healthy service, and the agent delivered nothing for days. Two incidents of that class:
April 13–19 and September 24–27, 2026.

## What is logged

All lines come from the broker's status stream and carry stable, non-secret fields only.
No endpoint, token or raw error text is copied.

| Status | Line | Rate limit |
|---|---|---|
| `disconnect` | `Server link lost; reconnecting` with `disconnectedAt` | every time |
| `reconnecting` | `Server link still lost; reconnect attempts continue` with `attempts`, `disconnectedAt`, `disconnectedForMs` | once per `reconnectLogIntervalMs` (default 60 s) per loss |
| `reconnect` | `Server link restored` with `attempts` and `wasDisconnectedForMs` | every time |
| `error` | `Server reported an error` with a reason (`broker.unauthorized`, `broker.permission-denied`, `broker.connection-refused`, `broker.name-unresolved`, `broker.timeout`, `broker.connection-failed`) | once per interval per reason |
| `staleConnection` | `Server stopped answering pings; the client will reconnect` | once per interval |
| connection closed | `Server connection closed for good; it will not reconnect on its own` with the reason | once |

`closed` is what nats.js does after two consecutive authorization failures (a rotated or
revoked token) or when reconnect attempts are exhausted. Nothing in the process brings the
link back after that; only a restart does.

## What `murmur status` shows

`daemon-observation.json` (schema `murmur.runtime/1`) and `murmur status --json` carry:

| Field | Meaning |
|---|---|
| `broker.state` | `connected`, `disconnected`, `unauthorized`, `closed`, `unknown` |
| `broker.disconnectedAt` | RFC3339 instant the link was lost; `null` while connected |
| `broker.reconnectAttempts` | failed reconnect attempts since that loss |
| `broker.lastError`, `broker.lastErrorAt` | last stable reason and when |

A `closed` link is a red `broker.closed` verdict; `disconnected` stays yellow
`broker.unreachable` because the client is still trying.

## When the daemon exits

The daemon ends with exit code 3, after draining, so the service manager restarts it and
records the failure:

- **the link closed for good** — default on. `MURMUR_EXIT_ON_CLOSED=0` in the environment
  or `"exitOnClosed": false` in `agent-config.json` keeps the process alive as before;
- **the link stayed lost longer than allowed** — off by default. Set
  `MURMUR_MAX_DISCONNECTED_MS` or `"maxDisconnectedMs"` in `agent-config.json`, in
  milliseconds; the watch checks every quarter of that value (1–30 s). A daemon that never
  reached the server counts from its start.

The watch lives in `scripts/daemon-link-watch.mjs`; the counters in
`packages/broker-nats/src/link-tracker.ts`.

## Supervisors

- **systemd** — `Restart=always` (or `on-failure`) with `RestartSec`; the exit shows in
  `systemctl status` and `journalctl -u`.
- **launchd** — `KeepAlive` restarts the job; the exit code lands in the job's log.
- **Windows Service** — the Service installed by Murmur has recovery actions set to
  restart; the exit shows in the Event Log and in the tray's status line.

A restart loop on an authorization failure stops at the supervisor's start limit and is
visible there, which is the point: a wrong token is a configuration problem to fix, not a
condition to hide.
