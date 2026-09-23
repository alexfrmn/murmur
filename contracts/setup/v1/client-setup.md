# Client setup and returned-reply contracts

These additive CLI contracts are separate from the frozen status/doctor fixture packet.

`clients preview --client ID --data-dir ABSOLUTE --json` returns `murmur.client-plan/1`:
`client`, `configPath`, `agentId`, lexical `dataDir`, `action` (`add|replace|unchanged`),
`planId` (SHA256), `configExisted`, and `restartRequired: true`. It reads only; it
creates neither the target nor its parent. No old config values/auth are returned.

`clients configure --client ID --plan-id SHA256 [--replace] --data-dir ABSOLUTE --json`
recomputes the plan under the existing Murmur lock. Changed bytes, target, identity
or runtime cause `client.plan-stale`. `replace` is independently required for an
existing different entry. `murmur.client/1` adds `planId`, `agentId`, and `dataDir`
to its existing receipt when a plan is supplied. An unchanged entry is not rewritten.
Existing file bytes are backed up privately. Auth files are never opened, clients
are never launched/reloaded, and unrelated parsed settings remain intact; original
comments/formatting are retained in the exact backup. The lock coordinates Murmur
writers; a final reread narrows, but cannot eliminate, a race with a non-cooperating
external writer. A timeout is an unknown outcome; obtain a fresh preview before retry.
Legacy configure without a plan remains supported for explicit CLI callers.

`reply-test prepare --peer ID --data-dir ABSOLUTE --json` returns
`murmur.reply-test-plan/1`: `agentId`, `peerId`, `conversationId`, opaque `token`,
`createdAt`, `expiresAt` (15 minutes), `requestText`, `expectedReply`. The caller
asks its selected AI client to invoke `murmur_send` with `to`, `conversationId`,
and exactly `requestText`. Preparing itself neither sends nor writes state.

`reply-test check --test-token TOKEN --data-dir ABSOLUTE --json` returns
`murmur.reply-test/1`: `generatedAt`, matching IDs, `state`
(`not-sent|waiting|replied|expired`), nullable `requestMsgId`, `replyMsgId`, `receivedAt`.
It checks the configured identity and peer key fingerprint, then reads a consistent
SQLite snapshot. Completion requires both the exact outbound request and the inbound
reply from the selected peer, conversation and nonce within the test window (5s clock
allowance), including channel/member routing where configured. Message bodies and
unrelated conversations are not returned. It does not advance read state, enqueue,
contact a broker, or update pair proofs. Missing/unreadable storage is an error.

The token carries correlation metadata, not credentials. Durable reply observation
trusts the local daemon's validated store; it is not new envelope verification,
proof of LLM authorship, or evidence that a particular closed UI session woke up.
