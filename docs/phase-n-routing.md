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
the subject before any proxy wake effect runs. Proxy subscriptions are wake bridges:
they emit no delivery ACK/NACK on behalf of the addressee, including for fieldless
traffic. The addressed agent must acknowledge delivery itself; see
[`protocol-v1.md`](protocol-v1.md#signed-ack-migration).

## Optional channel subjects (N5)

Default routing remains `msg.<agent>`. Receivers can opt into additional channel
subjects while keeping their existing durable consumer and cursor:

```json
{
  "subject": "msg.receiver",
  "jetstream": { "enabled": true, "stream": "MURMUR" },
  "channelRoster": { "enabled": true },
  "subjectScoping": { "enabled": true, "channelIds": ["channel-example"] }
}
```

The daemon requires an open local roster membership for every configured channel.
Each channel uses `msg.<agent>.c_<base64url(UTF8 channelId)>`: reversible encoding
keeps dots, wildcard characters and Unicode inside one literal NATS token. Channel
IDs are limited to 512 UTF-8 bytes; configure at most 256 channels per receiver.
Signed envelope metadata must match the receiving channel subject. A wrong-subject
copy is rejected without poisoning delivery of the same letter on its correct route.

All consumers use the **same existing stream**, normally covering `msg.>` and
`ack.>`. NATS prohibits overlapping stream subjects within an account: do not create
a new stream per channel under an existing `msg.>` stream. Channel durables use a
stable hash of base subject, receiver and channel; their exact `filter_subject` never
overlaps the legacy exact mailbox subject. Application dedupe/ACK identity remains
the agent ID across every route. Concurrent legacy/scoped copies serialize by
message ID inside the daemon before the shared durable dedupe check.

Migration, with the receiver's private configuration selected by `DATA_DIR`:

1. Upgrade receiver code, populate its roster and add the receiver config above.
2. Run `node scripts/murmur-subject-migration.mjs --plan`. This reads existing
   stream coverage and durable filters without modifying them. Permission errors,
   uncovered subjects and incompatible consumers abort the plan.
3. Run `--prepare` to add channel consumers idempotently. It neither creates nor
   edits a stream, deletes consumers, nor resets the legacy cursor. Partial prepare
   is safe to rerun. Start the receiver; verify all expected subscriptions.
4. On each sender, add `subjectScoping: true` to that peer's existing config entry.
   MCP send/request and the shell sender (including native reply relay) then use
   scoped subjects only for messages with `channelId`. Fieldless messages keep the
   legacy subject. Existing queued outbox rows retain their original subject.
5. Verify both legacy and scoped delivery. The MCP channel bridge subscribes to
   both forms and applies signature, addressing and lease checks before a session
   notification. It emits no delivery ACK on behalf of the persistent daemon.

Rollback: disable `peers.<peer>.subjectScoping` on **all senders first**, drain their
already queued scoped rows, then run `--check-rollback` at the receiver. A nonzero
exit / `safeToDisableReceivers: false` means pending or unacknowledged channel
messages remain. Repeat after they drain; only then disable receiver subject
scoping. Keep the dormant channel consumers and stream data for resumption; this
workflow performs no destructive cleanup. A zero count is a point-in-time check,
not a fence against a publisher that is still enabled. Existing legacy consumers
continue throughout rollout and rollback. No shared broker restart is required.

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
