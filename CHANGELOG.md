# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending
- **NATS transport security (TLS + per-peer auth)** — reviewed and CI-green in #103, held for a coordinated broker/peer credential cutover. It intentionally makes existing non-loopback `nats://` configurations fail closed, so it ships with a maintenance window, not as a routine merge.
- **Strict wire-breaking ACK envelope** — #104 (draft), the strict counterpart to the compatible signed-ACK path shipped below. Under evaluation for the delta it carries over #100 (nonce persistence across restarts, exactly-once outbox transitions, removal of the A2A raw-NACK shortcut).

## [2.5.0] - 2026-08-20

> First release built substantially from **external contributions**. The security series came from an
> independent audit by [@fedoseevstanislav](https://github.com/fedoseevstanislav); the wake fixes and the
> delivery-semantics analysis came from [@alexanderyswork](https://github.com/alexanderyswork).

### Security

- **Signed and bound delivery acknowledgements** (#100) — ACK correlation previously trusted attacker-controlled JSON carrying only `{msgId, status}`: anyone able to publish to an ACK subject could mark an arbitrary pending outbox row `acked` or `failed`, suppressing delivery or forcing retries without authenticating as the consumer. ACKs are now a versioned `SignedAckV1` with an Ed25519 signature over the message digest, conversation, ACK sender, intended recipient, status, timestamp and nonce; wrong-message, wrong-conversation, wrong-recipient, wrong-peer, stale/future, invalid-signature and replayed ACKs are rejected, and ACK/NACK state changes apply atomically only from the `sent` state. Invalid attempts are metered by bounded reason as metadata-only security events — raw ACK and message bodies are never logged. **Migration is deliberately two-stage:** upgraded daemons emit signed ACKs that legacy peers still parse; strict rejection is opt-in behind `ackSecurity.requireSigned` / `MURMUR_REQUIRE_SIGNED_ACKS=1` until every peer is upgraded.
- **Hardened local state handling** (#101) — the daemon now sets umask `0077` before state/database creation, creates state directories `0700`, atomically creates/replaces secret JSON as `0600`, rejects symlinked, non-regular and wrong-owner config paths, reads configs with `O_NOFOLLOW` and re-checks the opened descriptor, and forces SQLite database/WAL/shared-memory files to `0600`. Agent configs hold long-term signing/encryption private keys and NATS credentials, and rewrites could previously return them to `0664`; SQLite files containing decrypted history were commonly `0644`. OpenClaw config setup no longer prints secret-bearing fields. `SECURITY.md` now documents that local message bodies remain plaintext and require a dedicated OS identity plus encrypted storage or an explicit retention policy.
- **Dashboard rendering and ingress** (#102) — the optional dashboard renders every untrusted field through DOM `textContent` (no `innerHTML`, inline scripts or inline handlers), serves a strict CSP plus clickjacking, MIME-sniffing, referrer, opener, resource and cache protections, and requires Basic authentication backed by a private server-local token file for both HTTP and WebSocket access. Live messages are accepted only after envelope-schema, signature, NATS subject/recipient binding, traffic-direction and known-peer verification; the listener stays loopback-only. **Fails closed** unless `DASHBOARD_TOKEN_FILE` exists with at least 32 URL-safe characters and no group/other permission bits.

### Fixed

- **Codex wake seeded threads are usable** (#97) — `thread/start` no longer discards `thread.path`, and new threads carry `peer.cwd` instead of starting at `cwd: null`, which previously produced wrong workspace roots, missing project instructions and wrong permissions.
- **Per-peer `baseInstructions` no longer dropped** (#98) — `normalizeWakeConfig` carries the value through, making the injector's `peer.resume === false` opt-out reachable from real configuration for the first time.

### Added
- **Production file-level deploy tooling** — `deploy/production-file-deploy.sh`
  now builds gitignored `dist/` artifacts before copying the live-runtime
  allowlist, includes Phase N core/MCP/channel roster files, and refuses to
  deploy if channel/personality markers are missing. Added
  `deploy/production-channel-roster-ops.sh` plus docs for the non-checkout
  production tree.
- **Phase N / N1 channel roster primitives** — `@murmurv2/core` now exposes `ChannelRosterStore` plus typed `ChannelRecord` / `ChannelMemberRecord` APIs. The roster keeps `channelId` distinct from legacy `conversationId`, stores `channels` / `channel_members` in a dedicated SQLite store, preserves existing message-history APIs, and reserves member-level `personaId`, `model`, `baseInstructionsHash`, and `eligibility` fields for N2 addressing and N3 personality binding.
- **Phase N / N2 addressing policy primitive** — `ChannelRosterStore.evaluateAddressing()` returns a shared reject/append/wake decision for `channelId` + explicit addressee flows: legacy no-channel remains broadcast, non-members are rejected, addressed members wake, and observers append history while staying muted.
- **Phase N / N3 personality binding** — `buildChannelThreadStartBinding()` projects a `ChannelMemberRecord` into Codex app-server `thread/start` overrides (`model`, `personality`, optional `baseInstructions`, and audit metadata). Daemon wiring is opt-in only (`channelRoster.enabled` or `MURMUR_CHANNEL_ROSTER=1`) and leaves legacy wake behavior unchanged by default.
- **Phase N / N6 MCP roster surface** — `@murmurv2/mcp-server` exposes `channel_create`, `channel_list`, `channel_members`, and `channel_evaluate_addressing`, backed by `MURMUR_CHANNEL_ROSTER_PATH` (default `DATA_DIR/channel-roster.db`) so agents and UI can manage rosters without direct SQLite access.

### Known gaps
- **Auth enforcement end-to-end** — the broker ingress hook + `authorizeInbound` exist; the daemon does not yet wire them (so `MURMUR_ENFORCE_AUTH` is not enforced end-to-end). Requires daemon roster/identity wiring + token provisioning.
- **Delivery semantics** — failed wakes still advance the cursor and the relay is not idempotent (#105); an empty `finalText` still logs as relayed (#106); `WakeMonitor.drain` is sequential (#107); `threadId` is process-memory only and scoped per peer (#108). All four reported by @alexanderyswork in #96.

### Published
- **npm** — `@murmurv2/core` @ **`0.4.0`** (adds the signed-ACK primitive and the `SignedAckV1` protocol schema). `@murmurv2/broker-nats` @ `0.3.0` (signed-ACK emission and verification at the transport boundary), `@murmurv2/mcp-server` @ `0.2.0` (channel roster surface). `@murmurv2/federation` @ `0.2.0`; `bridge-murmur` @ `0.1.1`; `observability` @ `0.1.2`; `security` @ `0.1.1`; all other `@murmurv2/*` @ `0.1.0`.

## [2.4.0] - 2026-06-23

> Retroactively written on 2026-08-20. The v2.4.0 tag and GitHub release shipped on 2026-06-23 pointing
> at "See CHANGELOG.md for details", but the section was never added — the release notes lived only on
> the tag. Reconstructed here from the release body and the #77 epic record.

### Added

- **DB-backed session-ownership lease.** For an addressed conversation, only the owning session of the addressed agent responds; every other session and agent stays silent. Fixes multi-session double-emit and native wake hitting or spawning the wrong session.
- **`SessionLeaseStore`** — atomic CAS `claim_or_skip`, heartbeat, per-turn fencing token, `session_presence` registry, `preemptPrefix`. Published in `@murmurv2/core@0.3.0`.
- **Presence-deferring native wake** — `createNativeLeaseGate` defers to a live interactive session and claims only as a cold fallback, behind `MURMUR_SCOPED_CHANNELS` (default OFF, backwards compatible).
- **All delivery paths honour one claim** — MCP channel, foreground push and coldstart each claim, fence and suppress against the same contract.

### Validated

- Lease smoke 11/11, wake-lease 7/7, cross-path coordination 9/9, real multi-process race N→1, wake-monitor regression green. Live: N sessions → exactly one emit, native defer with no competing thread.
- External review by the Stas team: approved, no blockers; two minor notes closed (token-monotonicity fence invariant, reserved `native:` preempt namespace).

## [2.3.0] - 2026-06-22

### Added

- **Agent discovery — complete.** Presence frames + candidate registry (ttl expiry, dedupe, out-of-order guard); signed presence with NATS `announcePresence`/`subscribePresence`; operator promote-flow (`queryCandidates` + `promoteCandidate`) returning the live nested peer-config entry. Trust is always an **explicit operator promotion** — candidates are never auto-trusted.
- **Message streaming — complete.** Stream frames (`stream.start`/`chunk`/`end`), UTF-8-safe chunking, in-memory + durable SQLite reassembly (out-of-order, idempotent, conflict-reject), backpressure (chunk + byte windows), sha256 per-chunk/whole-stream integrity, and an ACK-window.
- **Auth/authz enforcement mechanism** — `signAuthToken`/`verifyAuthToken` now carry a signed **`subject`** (actor); `EnvelopeV1` gains an optional, signed **`authToken`** (bearer `MURMUR-AUTH:…`, appended to the canonical payload only when present → byte-identical back-compat when absent); `@murmurv2/federation` `authorizeInbound` verifies it and binds `subject === senderAgentId`; `@murmurv2/broker-nats` enforces at ingress via an injected `InboundAuthorizer` hook behind `MURMUR_ENFORCE_AUTH` (default OFF, NACK `auth-rejected:<reason>`, never delivered). *Daemon end-to-end wiring pending (see Unreleased).*
- **Conformance suite — extended to every wire type.** `PresenceFrameV1`, `SignedPresenceFrameV1`, `StreamStart`/`StreamChunk`/`StreamEnd` (+ a discriminated `StreamFrame` `oneOf`) added to `protocol-v1.schema.json` and to schema↔runtime-guard agreement matrices; new structural guards `isStreamStart`/`isStreamChunk`/`isStreamEnd`/`isStreamFrame`.
- **Versioned protocol spec.** `docs/protocol-v1.md` (prose lifecycle for envelope, discovery, streaming) + `docs/protocol-compatibility.md` (field tables + per-type validation entrypoints + runtime-only-checks boundary) covering all wire types.

### Changed

- **`stableEnvelopePayload` centralized** into `@murmurv2/core` as the single canonical signing form (was byte-identically copy-pasted across 7 sites: mcp-server, daemon, bridge-a2a, shell-send, demos, agent-runner example, federation live test). Golden-locked by test.

### Fixed

- De-flaked the `mcp-request-reply` C2 long-poll-timeout test (real-timer boundary race → injectable fake clock).

### Validated

- **Real cross-host A2A.** A fresh Murmur agent deployed on Phoenix/agent-hq over the **published** `@murmurv2/*` packages connected to the live broker over Tailscale and exchanged **bidirectional** encrypt/verify/ACK messages with JARVIS — exercising the mesh across real hosts and network (closes the "real mesh deploy" mechanism gate; a second real partner *org* for federation remains an external gate).

## [2.2.0] - 2026-06-22

### Added

- **Published on npm.** All `@murmurv2/*` packages are public on the npm registry @ `0.1.0` (MIT), under the `murmurv2` org. Publish tooling: `scripts/prep-publish.mjs` (private→public, license, `publishConfig`, intra-workspace `file:`→`^0.1.0`, per-package `prepack` build guard, `files: dist/src + LICENSE`) and `scripts/publish-all.mjs` (root build → topological order → per-tarball assertion that `dist/src/index.{js,d.ts}` exist → publish). `@murmurv2/broker-ws` ships in the next release.
- **WebSocket transport adapter** — `@murmurv2/broker-ws`: relay server + broker client with envelope delivery, ACK correlation, dedupe, and invalid-envelope NACKs, reusing the core primitives. Browser/edge deployment examples pending.
- **Roster-backed auth tokens** — `@murmurv2/federation`: `signAuthToken`/`verifyAuthToken` issue Ed25519-signed tokens with audience, scopes, and `nbf`/`exp` windows; the issuer verify key is resolved from the verified roster (no embedded trust root).
- **`RosterStore`** — `@murmurv2/federation`: pinned-key trust + monotonic-version replay guard (rejects stale/downgraded rosters) + trust-epoch reset on key rotation.
- **Machine-readable protocol schema + conformance** — `@murmurv2/core/schema/protocol-v1.schema.json` (Draft 2020-12; root validates `EnvelopeV1`, `#/$defs/AckV1` for acks) + `docs/protocol-compatibility.md` matrix; the conformance suite asserts the schema and `isEnvelopeV1` agree on every accept/reject.
- **Federation live interop (in isolation)** — cross-org sealed+signed delivery proven over real NATS accounts and a leaf-node topology with least-privilege publish/subscribe boundaries (`packages/federation-nats/integration/`); a NATS accounts-config renderer generates each org's account contract.
- **ACP autonomy loop** — idempotent Murmur→ACP task producer + a gated send-boundary worker client.

### Changed

- README, file tree, and Roadmap synced to the real state, with honest scoping for in-isolation / mock-counterpart features.

## [2.1.0] - 2026-06-21

### Added

- **JetStream durability (opt-in).** Optional NATS JetStream durable consumers behind the existing broker/outbox interface — finite `max_deliver` (default 5) + `ack_wait` (default 30s), automatic repair of drifted consumers, retryable-failure `nak()` for broker redelivery, and poison-message terminal ACK. Default-OFF; enable with `MURMUR_JETSTREAM=1` or `config.jetstream.enabled`. The SQLite outbox remains the transactional source of truth.
- **JetStream advisory → DLQ.** `startJetStreamAdvisoryDlq` routes `MAX_DELIVERIES` / `MSG_TERMINATED` advisories to the outbox dead-letter sink.
- **Federation (cross-org).** New `@murmurv2/federation` — `org/agentId` addressing (bare id ⇒ local org) and an Ed25519-signed per-org key directory (roster) — and `@murmurv2/federation-nats` — NATS leaf-node / per-org account `fed.*` subject contract with subject-safe token encoding and account export/import isolation. Payload stays E2E-opaque across federation.
- **A2A bridge skeleton.** `@murmurv2/bridge-a2a` terminates the industry-standard A2A protocol (`@a2a-js/sdk`) and re-wraps tasks as internal Murmur E2E envelopes.
- **Native wake self-heal.** Codex app-server wake threads are re-seeded automatically when missing/stale; WS-over-UDS transport for the Codex app-server.

### Changed

- Wake/notify runtime no longer routes through OpenClaw or tmux persistent injection; native Claude/Codex wake plus Telegram notify are the supported paths.

### Security

- `verifyRoster` verifies a federation roster against a caller-pinned org key, not the roster's own embedded key — prevents an attacker from publishing a self-signed forged roster.

## [2.0.0] - 2026-06-20

### Added

- `murmur_request` send-and-wait tool for synchronous request/response over NATS.
- Mandatory WakeMonitor with deduplication, loop-breaker, audit-gate, and drain guards.
- WakeMonitor stateless and persistent wake modes.

### Fixed

- ACK routing now targets the original sender, not the consumer.
- Reconnect resilience defaults for long-running NATS clients.

### Changed

- Transport documentation now reflects core NATS plus SQLite outbox behavior without claiming JetStream durability.
- Security bump: `ws` upgraded to 8.21.0.

## [0.2.0] - 2026-03-26

### Added

- Deduplication by sender + conversationId + msgId with max 3 attempts before dead-letter ([109f27f])
- Bidirectional Murmur -- auto-reply OpenClaw responses via NATS ([2cc2d41])
- Observatory dashboard with 3D visualization ([58bf271])
- Bridge inbound Mur-Mur messages into OpenClaw sessions ([960b1d0])
- Operations guide covering queues, retry policy, and troubleshooting ([e302a83])

### Fixed

- Murmur resilience -- OpenClaw fallback + WAL busy_timeout ([5bd0e80])
- Rewrite on-receive-openclaw.mjs to use CLI instead of broken cron tool ([aaec353])
- Dead-letter on 400 responses + truncate Telegram messages over 4000 chars ([4324488])
- Bridge timeout increased to 120s, atomic claimDue, flush mutex ([a3d95ad])

### Changed

- NATS keepalive: 30s ping interval, infinite reconnect, named connections ([b67d64b])

## [0.1.0] - 2026-02-11

### Added

- Durable unified notify queue with quick init presets ([e7069d0])
- Invite-based peer setup -- 3 commands, zero JSON editing ([6a60294])

[Unreleased]: https://github.com/alexfrmn/murmur/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/alexfrmn/murmur/compare/v0.2.0...v2.0.0
[0.2.0]: https://github.com/alexfrmn/murmur/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alexfrmn/murmur/releases/tag/v0.1.0
