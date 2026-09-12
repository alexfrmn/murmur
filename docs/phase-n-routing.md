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
the subject before any proxy wake effect runs. Fieldless proxy traffic retains its legacy
behavior.

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
