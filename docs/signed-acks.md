# Signed ACK rollout

Murmur delivery acknowledgements are signed application messages. An ACK is
accepted only when its Ed25519 signature is trusted, its timestamp is fresh, its
nonce has not been processed before, and its sender, recipient, conversation,
message id, and envelope digest match the pending outbox record.

This is a wire-breaking security upgrade. Legacy `{msgId,status}` ACKs fail
closed, and older consumers cannot produce the signed `AckV1` shape. Upgrade all
active Murmur producers and consumers in one coordinated maintenance window.

## Required configuration

Every `NatsBroker` and `WebSocketBroker` delivery or correlation instance must
receive `ackSecurity` with:

- the real local agent id;
- a signer backed by that agent's existing Ed25519 private key; and
- a verifier that resolves the claimed ACK sender to its pinned Ed25519 public
  key and fails closed for unknown peers.

The daemon, MCP channel server, agent runner, and demos already wire this from
their existing key configuration. Private key material must not be copied into
logs, ACK frames, environment diagnostics, or migration output.

## Coordinated rollout

1. Back up the Murmur SQLite/JSON state files and confirm every active peer has a
   signing private key plus pinned signing public keys for its recipients.
2. Stop message-producing and message-consuming Murmur services on every peer.
3. Deploy the upgraded core and broker packages to every peer.
4. Start the brokers and consumers, then the producers.
5. Send one real message in each direction and confirm a signed ACK moves the
   matching outbox row to `acked` exactly once.
6. Replay the captured ACK in an isolated test and confirm it is rejected as
   `replay`; submit an unsigned legacy ACK and confirm it is rejected as
   `unsigned-or-invalid`.
7. Confirm rejection telemetry contains only reason, message id, and sender id,
   never raw frames or decrypted content.

Keep per-peer NATS publish/subscribe ACLs enabled as a separate defense. Signed
ACKs make forged frames ineffective; broker ACLs reduce who can send frames to
the ACK subjects in the first place.

## Rollback

Rollback must also be coordinated across all peers. Stop all Murmur traffic,
restore the prior package set everywhere, and restart consumers before producers.
Do not run mixed legacy and signed-ACK peers: that causes legitimate deliveries
to retry because their acknowledgements are mutually incompatible.
