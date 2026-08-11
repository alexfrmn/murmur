# Codex Mac Wake Relay Runbook

This runbook documents Alex's Mac deployment of Murmur wake for Codex Desktop.
It is intentionally operational: keep it accurate before changing the Mac
LaunchAgents or the Codex app-server wake path.

## Current Topology

- Agent id: `agent-codex-mac-kovalyaevo`
- Broker: `tls://nats.server-pilot.ru:4222`
- Peer that wakes Codex on the Mac: `agent-jarvis`
- Murmur repo on the Mac: `/Users/alex/.local/share/mur-mur-v2`
- Mac data dir:
  `/Users/alex/.local/share/mur-mur-v2/.data-codex-mac-kovalyaevo`
- Mac SQLite store:
  `/Users/alex/.local/share/mur-mur-v2/.data-codex-mac-kovalyaevo/murmur.db`
- Murmur daemon LaunchAgent: `com.alex.murmur.codex-mac-kovalyaevo`
- Wake app-server LaunchAgent: `com.alex.codex.murmur-wake-app-server`
- Wake app-server socket:
  `/Users/alex/.codex/murmur-wake-app-server/app-server.sock`
- Wake target thread as of 2026-07-07:
  `019f3c56-6691-76c1-b830-896ee120ef75`

Do not print the full `agent-config.json` in logs or chats; it contains mesh
secrets. Safe fields to report are `agentId`, `natsUrl`, `wake.peers` names,
`mode`, and `relayFinalToMurmur`.

## Why the Relay Exists

Codex Desktop and a LaunchAgent-managed `codex app-server` are separate clients.
The app-server can start a hidden turn and write to the same session JSONL, but
it does not necessarily bring the visible Desktop UI to the foreground.

The hidden turn also runs under Codex sandbox/approval settings that are not
suitable for writing the Murmur SQLite store directly. The hidden Codex turn must
therefore not call `murmur-shell-send.mjs` itself.

The contract is:

1. Murmur daemon receives inbound from `agent-jarvis`.
2. Daemon starts/resumes the configured Codex app-server thread.
3. Hidden Codex turn returns only the reply body as its final answer.
4. Daemon captures that final answer.
5. Daemon sends the reply through `scripts/murmur-shell-send.mjs` using the Mac
   Murmur data dir and store path.

## Config Shape

The Mac peer config needs these wake fields:

```json
{
  "wake": {
    "peers": {
      "agent-jarvis": {
        "mode": "codex_app_server",
        "socketPath": "/Users/alex/.codex/murmur-wake-app-server/app-server.sock",
        "threadId": "019f3c56-6691-76c1-b830-896ee120ef75",
        "cwd": "/Users/alex/Library/CloudStorage/OneDrive-Личная/WorkToWork/AI",
        "murmurRoot": "/Users/alex/.local/share/mur-mur-v2",
        "dataDir": "/Users/alex/.local/share/mur-mur-v2/.data-codex-mac-kovalyaevo",
        "storePath": "/Users/alex/.local/share/mur-mur-v2/.data-codex-mac-kovalyaevo/murmur.db",
        "relayFinalToMurmur": true,
        "replyTimeoutMs": 600000
      }
    }
  }
}
```

`natsUrl` must use `tls://`. The per-agent broker username/password, CA path,
and mesh keys are not part of this runbook.

## Implementation Notes

- `scripts/wake-monitor.mjs` preserves relay fields during config
  normalization.
- `scripts/codex-app-server-wake.mjs` adds a `[MURMUR REPLY RELAY]` instruction
  to the hidden Codex turn when `relayFinalToMurmur` is enabled.
- `startTurnAndWaitForFinal` captures final answers from app-server events when
  available.
- If app-server events miss `turn/completed`, it polls the resumed thread's
  session JSONL and reads `task_complete.last_agent_message` by `turnId`.
- The daemon launches the reply sender with `process.execPath`, not `node`, so
  it works under macOS LaunchAgent environments with a minimal `PATH`.

## Operational Checks

Daemon and app-server:

```bash
launchctl list | rg 'murmur|codex.murmur'
```

Broker and daemon log:

```bash
tail -n 120 /Users/alex/Library/Logs/murmur/codex-mac-kovalyaevo.out.log
```

Safe config summary:

```bash
node - <<'NODE'
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(
  '/Users/alex/.local/share/mur-mur-v2/.data-codex-mac-kovalyaevo/agent-config.json',
  'utf8',
));
console.log(JSON.stringify({
  agentId: cfg.agentId,
  natsUrl: cfg.natsUrl,
  wakePeers: Object.keys(cfg.wake?.peers || {}),
  jarvisWake: {
    mode: cfg.wake?.peers?.['agent-jarvis']?.mode,
    relayFinalToMurmur: cfg.wake?.peers?.['agent-jarvis']?.relayFinalToMurmur,
    replyTimeoutMs: cfg.wake?.peers?.['agent-jarvis']?.replyTimeoutMs,
  },
}, null, 2));
NODE
```

Mac local message and outbox check:

```bash
sqlite3 -header -column \
  /Users/alex/.local/share/mur-mur-v2/.data-codex-mac-kovalyaevo/murmur.db \
  "select created_at,direction,sender,conversation_id,msg_id,substr(replace(text,char(10),' '),1,180) as text
   from local_messages
   where conversation_id='<conversation-id>'
   order by created_at;
   select msg_id,status,attempts,coalesce(last_error,'') as err,created_at,updated_at
   from outbox
   where msg_id in (
     select msg_id from local_messages
     where conversation_id='<conversation-id>' and direction='outbound'
   );"
```

Server-side verification on agent-command-center:

```bash
ssh -T agent-command-center \
  "cd /opt/lifecoach/mur-mur-v2 && sqlite3 -header -column .data/murmur.db \
   \"select created_at,direction,sender,conversation_id,msg_id,substr(replace(text,char(10),' '),1,180) as text
     from local_messages
     where conversation_id='<conversation-id>'
     order by created_at;\""
```

## Last Known Good Verification

Reply-window smoke on 2026-08-06:

- Conversation: `codex:wake:reply-timeout-smoke-20260806T0818Z`
- Mac inbound: `376adb3f-ca05-4f9b-988d-9b607007927d`, DB row `110`
- Mac outbound: `8c02926b-5a51-44ad-9b85-0ad91acf29fe`, DB row `111`
- Evidence: outbox `acked` on attempt `1`; server DB received the reply in row
  `4734`
- DORFA canary receipt: `6433daaf-c7b0-439a-8de0-cdf2b8ec0c4d`, server row
  `4735`

The 600-second window was introduced after a five-minute ontology canary
completed successfully but the former 180-second reply monitor reported a false
timeout. The new value changes reply collection only; the shared NATS broker was
not restarted.

Previous final smoke after the relay fix:

- Inbound from server/JARVIS:
  `68e84b1c-0db9-4293-9ee0-c9b9599d12f3`
- Conversation:
  `wake-relay-finalcheck-20260707T185104Z`
- Hidden Codex turn:
  `019f3deb-6ada-7a40-865a-589b54b7cc2c`
- Codex final:
  `WAKE_FINALCHECK_OK_20260707T185104Z`
- Daemon reply:
  `48a6b659-9357-4256-a842-f5bfb7ae9858`
- Evidence:
  Mac outbox `acked`, attempts `1`; server DB received inbound from
  `agent-codex-mac-kovalyaevo`.

Explicit online notice sent to Claude/JARVIS:

- Message:
  `589c2d3b-b9fe-400d-8b2e-aa6487bfbbc4`
- Conversation:
  `codex-mac-online-20260707T184902Z`
- Evidence:
  Mac outbox `acked`; server DB inbound verified.

## Failure Patterns

- `codex-app-server-turn-completion-timeout`: the hidden turn may still have
  completed in JSONL. Check the session log by `turnId`; the daemon should use
  the `session-log` fallback.
- `spawn node ENOENT`: LaunchAgent has no `node` in `PATH`. Use
  `process.execPath` for child Node scripts.
- Message is in Mac DB but no visible UI wake: not a transport failure. The
  current Mac path is headless app-server wake plus Murmur reply relay, not
  guaranteed Desktop foreground surfacing.

## Rollback

If relay breaks badly:

1. Restore the previous `agent-config.json` backup if the config changed.
2. Disable `relayFinalToMurmur`.
3. Restart `com.alex.murmur.codex-mac-kovalyaevo`.
4. Use manual `murmur-shell-send.mjs` or the old non-relay wake path until fixed.

Do not roll back the broker to the old 291 endpoint unless the current migration
plan explicitly says to do so.
