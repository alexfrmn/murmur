# Phase N structured member routing

Murmur has three separate identities:

- `senderAgentId` / `recipients` identify encrypted transport peers.
- `channelId` + `memberId` identify stable logical members in a typed channel roster.
- `conversationId` labels message history or a live client session; it is not membership.

Keeping these separate lets multiple logical members share one daemon or transport key
without inventing routing headers inside message text.

## Configuration

The MCP server and shell sender accept explicit `channelId`, `senderMemberId`, and
`addresseeMemberId` values. They may also default from private `agent-config.json`:

```json
{
  "agentId": "transport-a",
  "memberId": "member-a",
  "peers": {
    "transport-b": {
      "subject": "msg.transport-b",
      "channelId": "channel-example",
      "memberId": "member-b"
    }
  },
  "channelRoster": {
    "enabled": true,
    "path": ".data/channel-roster.db"
  }
}
```

The omitted key blocks are unchanged. Do not commit private keys, broker credentials, or
production-specific member names. Populate the same roster on every receiver before
enabling structured sends.

## Chat-session presence (N4)

Presence is an **advisory, local-host view** of sessions participating in a typed
channel, distinct from NATS peer discovery and from the session-ownership lease.
It never grants roster membership, changes addressing, claims a lease, or proves
that a UI has received a wake. Hosts do not replicate these rows across the mesh.

The MCP server exposes:

- `channel_presence({channelId})`: live local sessions, their member, conversation,
  status (`active`, `idle`, `busy`), join/heartbeat/expiry timestamps in epoch ms.
- `channel_presence_heartbeat({channelId, memberId?, status?, ttlMs?})`: join or
  refresh this session. `memberId` defaults to the local config; it must belong to
  that configured agent in an open channel. TTL defaults to 30 seconds and is
  bounded to 5–300 seconds. The client integration must repeat before expiry.
- `channel_presence_leave({channelId, memberId?})`: remove only this session's row.
  Roster membership and lease ownership are unchanged.

Agent identity comes from the private local config. Session identity is fixed for
the stdio server lifetime: `MURMUR_SESSION_ID`, then `CODEX_THREAD_ID`, then
`CLAUDE_CODE_SESSION_ID`, otherwise a process-generated UUID. Use a distinct session
ID per chat; two local sessions can report the same member independently. Tool
arguments cannot override the agent/session identity. Presence is opt-in through
these calls; there is no automatic timer claiming that an idle client is active.

Rows live in the existing roster DB (`MURMUR_CHANNEL_ROSTER_PATH`), not the lease
DB. Expired rows are filtered at read time and reclaimed on later heartbeats.
Channel closure, member departure or agent reassignment hides old rows immediately.
A crashed client ages out after TTL without shutdown cleanup. Stop heartbeats to
roll back; the additive table is inert on older versions. This reports recently
observed participation, not distributed or instantaneous online status.

## Receive hooks

Alongside the existing message variables, `onReceive` and `wake.auditHook` receive:

- `MURMUR_CHANNEL_ID`
- `MURMUR_SENDER_MEMBER_ID`
- `MURMUR_ADDRESSEE_MEMBER_ID`

They are empty for a legacy envelope. Routing metadata stays out of decrypted message
text and is returned separately by `murmur_inbox`.

The daemon also persists its local receive-time wake decision. Observer copies remain in
channel history but stay muted when processed later through the durable backlog. Existing
rows without that local decision retain legacy wake behavior.

Configured proxy subjects apply the same roster decision for the proxy agent derived from
the subject before any proxy wake effect runs. Proxy subscriptions are wake bridges:
they emit no delivery ACK/NACK on behalf of the addressee, including for fieldless
traffic. The addressed agent must acknowledge delivery itself; see
[`protocol-v1.md`](protocol-v1.md#signed-ack-migration).

## Coordinated rollout

1. Upgrade and build every peer while leaving existing fieldless sends unchanged.
2. Create the identical typed channel and member roster on every receiving host.
3. Enable `channelRoster` on receivers and verify legacy delivery still works.
4. Add private local/peer member defaults or pass explicit fields at the sender.
5. Test an addressed message and reply in each direction, then test two members sharing
   one transport agent to confirm request correlation and wake selection.

Receivers with the roster enabled reject unknown channels, unknown or mismatched sender
members, closed channels, and unknown addressees. An addressed observer may retain the
message in channel history but does not wake. Disabling structured sends is the rollback:
fieldless envelopes retain legacy v1 behaviour. Disable the roster only after all queued
structured messages have drained.
