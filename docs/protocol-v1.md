# Protocol v1

Murmur V2's wire protocol, `schemaVersion` **1.0**. The canonical machine-readable
contract is [`packages/core/schema/protocol-v1.schema.json`](../packages/core/schema/protocol-v1.schema.json)
(JSON Schema, Draft 2020-12); the `@murmurv2/core` runtime guards mirror it, and the
[conformance suite](../packages/core/test/conformance.test.mjs) asserts the schema and
the guards cannot drift. Versioning and forward-compatibility rules live in
[`protocol-compatibility.md`](protocol-compatibility.md).

## Wire types

| Type | Purpose | Schema `$def` | Runtime guard |
|------|---------|---------------|---------------|
| `EnvelopeV1` | encrypted inbound message | document root (`#/$defs/EnvelopeV1`) | `isEnvelopeV1` |
| `AckV1` | legacy unsigned delivery acknowledgement | `#/$defs/AckV1` | — |
| `SignedAckV1` | signed, peer/message-bound delivery acknowledgement | `#/$defs/SignedAckV1` | `isSignedAckV1` |
| `PresenceFrameV1` | discovery announcement (public metadata) | `#/$defs/PresenceFrameV1` | `isPresenceFrameV1` |
| `SignedPresenceFrameV1` | Ed25519-signed presence | `#/$defs/SignedPresenceFrameV1` | `isSignedPresenceFrameV1` |
| `StreamStart` / `StreamChunk` / `StreamEnd` | chunked payload streaming | `#/$defs/Stream*` (+ `StreamFrame` union) | `isStreamStart` / `isStreamChunk` / `isStreamEnd` / `isStreamFrame` |

Envelope message payloads are encrypted on the wire; presence frames are intentionally
**public, signed cleartext** metadata (no secret). In all cases the schema validates
**shape**, while signature verification and payload decryption are runtime concerns
(`@murmurv2/security`).

## Envelope lifecycle
1. Producer builds `EnvelopeV1`
2. Producer signs envelope and encrypts payload
3. Publish to subject `msg.<conversationId>`
4. Consumer validates schema+signature
5. Consumer processes idempotently using `msgId`
6. Consumer emits a signed ACK or NACK bound to the message digest, conversation, sender,
   recipient, timestamp, and nonce.
7. Sender verifies the signature against the expected peer key and applies an atomic transition
   only while the outbox row is in flight. Replays and mismatched bindings are rejected.
8. Retry policy moves failed messages; terminal failures go to DLQ.

### Signed ACK enforcement and rollout (#157)

The daemon emits `SignedAckV1` by default. Unsigned or malformed ACK/NACK frames
never change the outbox, including when a caller passes `requireSignedAcks: false`.
The old `ackSecurity.requireSigned: false` / `MURMUR_REQUIRE_SIGNED_ACKS=0`
configuration is deprecated: startup warns that the downgrade was ignored and
reports both the requested setting and the effective `requireSigned: true`,
`unsignedAction: "ignore"` policy. New configurations enable signatures explicitly.
An operator can still explicitly disable signed **emission** for an old receiver,
but startup warns that upgraded senders will ignore those receipts; it never
weakens incoming verification. Invalid boolean settings fail startup.

Before deploying this breaking enforcement change, inventory actual receiver
versions and remove/upgrade old observer ACK writers. Verify a signed positive
receipt after durable persistence and a signed NACK after a controlled storage
failure on an isolated broker. Legacy-only receivers will leave sender messages
pending/retrying instead of falsely acknowledged. No production restart or flag
change is implicit in this code change. Do not bulk requeue previously acknowledged
rows; reconcile each disputed delivery against the receiver's durable inbox first.

Correlation rejects legacy ACKs, stale/future
timestamps, wrong peers, wrong conversations or recipients, digest mismatches, invalid signatures,
and repeated/non-in-flight transitions. Rejections increment reason-tagged counters and emit
metadata-only security events; ACK bodies and message contents are never logged.

The receiver's success ACK means its durable inbox transaction committed. A handler
returning normally is therefore an assertion of persistence, not simply receipt
of a network frame. MCP/session observers and proxy taps must use
`emitDeliveryAcks: false` on every outcome, including lease skips and duplicates;
giving such a tap a signing key cannot make it a persistence authority. Only the
canonical receiver writes the inbox and then signs its receipt.

An authenticated positive receipt remains terminal. A later NACK from a failed
duplicate attempt does not undo the earlier committed copy; reopening it could
repeat downstream effects. The signed binding and durable inbox evidence must
be investigated if a receiver reports contradictory outcomes.

Retryable `failed` rows remain eligible for verified ACK/NACK transitions, alongside
`pending` and `sent`. A signed `poison-message:*` NACK settles them atomically as
`dlq`; neither `acked` nor `dlq` accepts another transition. ACK timeouts preserve
an existing failure reason so exhaustion reports the peer's diagnosis.

Outbox retries use `msgId:v<row-version>` as the JetStream transport dedupe ID.
The signed envelope is unchanged. The row version advances on NACK/timeout even
if a fast NACK prevented `markSent` from incrementing attempts, so the new send
reaches the receiver inside the server's duplicate window. Direct `publish()`
calls retain message-ID deduplication unless given an explicit transport ID.
External outbox stores that omit the optional row version get a fresh random
transport ID per publish call instead; receiver-side envelope deduplication still
applies. A constant or attempts-based fallback would suppress fast-NACK retries.

`config.proxySubjects` creates wake bridges, not delivery to another agent's inbox.
Proxy subscriptions suppress delivery ACK/NACKs, including errors and duplicate
receipts; their own JetStream consumer acknowledgements are independent. The
addressed agent must run a daemon and acknowledge with its own key. Without it,
the sender retries and eventually moves the unconfirmed message to DLQ; startup
logs warn about this condition. No proxy delegation or alternate signer is trusted.

An optional `authToken` (bearer `MURMUR-AUTH:…`) authorizes the sender. When present it
is part of the signed payload (cannot be stripped/swapped) and can be verified with
`@murmurv2/federation` `verifyAuthToken`; ingress enforcement (an `authorizeInbound`
helper gated by `MURMUR_ENFORCE_AUTH`) is forthcoming in auth/authz #47 PR-D. Absent on
un-authenticated envelopes, which sign byte-identically to before the field existed —
see [`protocol-compatibility.md`](protocol-compatibility.md).

### Typed channel identity and addressing

Phase N messages may carry the signed routing tuple `channelId`, `senderMemberId`, and
optional `addresseeMemberId`. `memberId` is stable within a channel and is distinct from
both the transport-level `senderAgentId` and the history/session label `conversationId`.
This lets several logical members share one transport agent while replies still correlate
to the intended member.

`channelId` and `senderMemberId` must appear together; `addresseeMemberId` requires them.
When the daemon's channel roster is enabled, it verifies the authenticated sender owns
`senderMemberId`, rejects unknown/closed channels or non-members, stores broadcasts for
the channel, and wakes only the explicit addressee. With no routing tuple, v1 legacy
delivery remains unchanged. See [`phase-n-routing.md`](phase-n-routing.md) for rollout.

## Delivery model
- at-least-once delivery
- idempotent consumers mandatory
- per-conversation sequence ordering target

## Discovery (presence)

Discovery never confers trust automatically — a presence frame proves only message
integrity, never that an `agentId` is who it claims. Trust is established out of band
by a deliberate operator promotion.

1. An agent announces a `PresenceFrameV1` — public keys, `subject`, `capabilities`,
   `ttlMs`, ISO-8601 `ts`, and a per-announcement `nonce` — on a discovery subject.
2. Announcements are wrapped as a `SignedPresenceFrameV1` (Ed25519 signature over the
   canonical frame). A listener verifies the signature against the key the frame
   advertises before folding it in (`announcePresence` / `subscribePresence` on the
   NATS broker; verification injected from `@murmurv2/security`).
3. Observers collect frames into a `CandidateRegistry` as **untrusted**
   `DiscoveryCandidate`s — deduped by (`agentId`, `nonce`), expiring at `ts + ttlMs`.
4. An operator (or an approved policy) introspects the roster with `queryCandidates`
   and explicitly promotes one with `promoteCandidate`, which returns the nested
   peer-config entry to wire into `peers[agentId]`. Promotion does not mutate the
   registry; the candidate stays untrusted until the operator applies the entry.

## Streaming

Large payloads are sent as an ordered sequence of stream frames sharing a `streamId`.

1. Producer opens with `StreamStart` — declared `chunkCount` and `totalBytes`
   (optional `contentType`, `startedAt`).
2. Producer emits ordered `StreamChunk`s — `chunkIndex`, **non-empty** `data`, an
   optional per-chunk `sha256`, and `isLast`. (A zero-byte chunk is rejected:
   `stream-chunk-data-required`.)
3. Producer closes with `StreamEnd` — optional whole-stream `digest` / `sha256`
   integrity tags.
4. Receiver reassembles idempotently by `streamId` (in-memory or SQLite-durable):
   duplicate chunks are no-ops, conflicting re-sends are rejected, integrity tags are
   verified, and completion yields the reassembled payload. Backpressure bounds the
   in-flight chunk and byte windows.

## Bridge mapping
- Murmur message -> EnvelopeV1
- OpenClaw session event -> EnvelopeV1
- Human channel events (Telegram etc.) -> EnvelopeV1

### ACK verification diagnostics

A signed frame whose sender key is unavailable is rejected with
`signature-key-unavailable`. A missing verifier is separately reported as
`signature-verifier-unavailable`. Neither means a cryptographic verification
failed: `signature-invalid` is reserved for an attempted check that did not
verify. Unsigned/malformed frames remain `unsigned-or-malformed`. Every rejection
leaves the outbox and replay nonce unchanged; after the correct public key is
installed, the same signed frame can be verified normally within its time window.
Only the literal successful verification result `true` can settle a record.

Observers and status consumers must distinguish signed-and-verified,
signed-but-unverifiable, and unsigned. An explicitly invalid signature is a
verification failure, not a missing-key condition. Invalid-ACK reason counters
are diagnostics, not a count of delivered messages or authenticated identities.

Both NATS and WebSocket use the core `AckVerificationResult` decoder. Its cases
are exhaustive at compile time; unexpected JavaScript values fail closed as
`signature-verifier-result-invalid`. WebSocket callers must supply `signAck` on
the receiver and `verifyAck` on the sender for delivery settlement. An unsigned
invalid-envelope NACK is diagnostic only and cannot fail a queue row.

WebSocket correlation checks the same default ACK age (five minutes), future
skew (30 seconds), and nonce replay rules. Supply a durable `ackReceipts` store
for replay protection across restarts; the default memory cache covers only the
current process. A failure publishing/signing an outcome after committed delivery
does not convert that delivery into a NACK.

Coverage correction: #159 originally removed unsigned settlement in NATS only.
The remaining WebSocket path was found during #162 review; #157 was reopened
until that transport was fixed and tested as well. Code merge is not runtime
rollout, and compatibility flags cannot re-enable unsigned queue mutation.
