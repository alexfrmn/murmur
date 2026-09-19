import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringCodec } from "nats";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import {
  JsonFileOutboxStore,
  createAck,
  createBoundAck,
  isSignedAckV1,
  stableAckPayload,
} from "../packages/core/dist/src/index.js";
import {
  createSigningKeyPair,
  signEnvelope,
  verifyEnvelopeSignature,
} from "../packages/security/dist/src/index.js";

const sc = StringCodec();

const envelope = {
  schemaVersion: "1.0",
  msgId: "msg-signed-ack",
  conversationId: "conv-signed-ack",
  senderAgentId: "agent-sender",
  recipients: ["agent-receiver"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("encrypted-message").toString("base64"),
  payloadNonce: "nonce",
  signature: "envelope-signature",
};

const createSentOutbox = async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-signed-ack-"));
  const outbox = new JsonFileOutboxStore(join(dir, "outbox.json"));
  await outbox.enqueue("msg.agent-receiver", envelope);
  await outbox.markSent(envelope.msgId);
  return outbox;
};

const signAck = async (unsignedAck, privateKey) => ({
  ...unsignedAck,
  signature: await signEnvelope(stableAckPayload(unsignedAck), privateKey),
});

const processAck = async (broker, outbox, ack, verifyAck, events = []) => {
  await broker.processAckFrame(sc.encode(JSON.stringify(ack)), {
    outbox,
    requireSignedAcks: true,
    verifyAck,
    onInvalidAck: (event) => events.push(event),
  });
  return events;
};

test("subscribeWithAck emits a signed message-bound ACK when a signer is supplied", async () => {
  const signing = await createSigningKeyPair();
  const published = [];
  const fakeSub = {
    async *[Symbol.asyncIterator]() {
      yield { data: sc.encode(JSON.stringify(envelope)) };
    },
  };
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  broker.nc = {
    subscribe() { return fakeSub; },
    publish(subject, data) { published.push({ subject, ack: JSON.parse(sc.decode(data)) }); },
    async drain() {},
  };

  await broker.subscribeWithAck({
    subject: "msg.agent-receiver",
    consumerId: "agent-receiver",
    dedupe: {
      async seen() { return false; },
      async markSeen() {},
    },
    onMessage: async () => {},
    signAck: (unsigned) => signAck(unsigned, signing.privateKey),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(published[0].subject, "ack.agent-sender");
  assert.equal(isSignedAckV1(published[0].ack), true);
  assert.equal(published[0].ack.messageDigest, createBoundAck(envelope, "agent-receiver", "ack").messageDigest);
  assert.equal(
    await verifyEnvelopeSignature(
      stableAckPayload(published[0].ack),
      published[0].ack.signature,
      signing.publicKey,
    ),
    true,
  );
});

test("strict ACK correlation rejects unsigned ACKs without changing the outbox", async () => {
  const outbox = await createSentOutbox();
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  const events = await processAck(
    broker,
    outbox,
    createAck(envelope.msgId, "agent-receiver", "ack"),
    async () => true,
  );

  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "sent");
  assert.equal(events[0].reason, "unsigned-or-malformed");
  assert.equal(broker.getAckSecurityMetrics()["unsigned-or-malformed"], 1);
});

test("a valid signed ACK is bound to the pending message and expected peer", async () => {
  const outbox = await createSentOutbox();
  const signing = await createSigningKeyPair();
  const unsigned = createBoundAck(envelope, "agent-receiver", "ack");
  const ack = await signAck(unsigned, signing.privateKey);
  const broker = new NatsBroker({ url: "nats://example.invalid" });

  await processAck(
    broker,
    outbox,
    ack,
    (candidate) => verifyEnvelopeSignature(
      stableAckPayload(candidate),
      candidate.signature,
      signing.publicKey,
    ),
  );

  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "acked");
});

test("wrong peer, conversation, recipient, digest, time, and signature cannot change outbox state", async () => {
  const signing = await createSigningKeyPair();
  const wrongSigning = await createSigningKeyPair();
  const cases = [
    { name: "unexpected-peer", patch: { senderAgentId: "agent-attacker" }, signer: signing },
    { name: "conversation-mismatch", patch: { conversationId: "other-conversation" }, signer: signing },
    { name: "recipient-mismatch", patch: { recipientAgentId: "other-recipient" }, signer: signing },
    { name: "message-digest-mismatch", patch: { messageDigest: `sha256:${"0".repeat(64)}` }, signer: signing },
    { name: "timestamp-out-of-window", patch: { at: "2020-01-01T00:00:00.000Z" }, signer: signing },
    { name: "signature-invalid", patch: {}, signer: wrongSigning },
  ];

  for (const item of cases) {
    const outbox = await createSentOutbox();
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    const unsigned = { ...createBoundAck(envelope, "agent-receiver", "ack"), ...item.patch };
    const ack = await signAck(unsigned, item.signer.privateKey);
    const events = await processAck(
      broker,
      outbox,
      ack,
      (candidate) => verifyEnvelopeSignature(
        stableAckPayload(candidate),
        candidate.signature,
        signing.publicKey,
      ),
    );

    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "sent", item.name);
    assert.equal(events[0].reason, item.name);
  }
});

test("replaying a signed ACK cannot create another outbox transition", async () => {
  const outbox = await createSentOutbox();
  const signing = await createSigningKeyPair();
  const ack = await signAck(
    createBoundAck(envelope, "agent-receiver", "ack"),
    signing.privateKey,
  );
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  const verifyAck = (candidate) => verifyEnvelopeSignature(
    stableAckPayload(candidate),
    candidate.signature,
    signing.publicKey,
  );

  await processAck(broker, outbox, ack, verifyAck);
  const afterFirst = await outbox.getOutboxRecord(envelope.msgId);
  const events = await processAck(broker, outbox, ack, verifyAck);
  const afterReplay = await outbox.getOutboxRecord(envelope.msgId);

  assert.equal(afterFirst.status, "acked");
  assert.equal(afterReplay.status, "acked");
  assert.equal(afterReplay.version, afterFirst.version);
  assert.equal(events[0].reason, "message-not-in-flight");
});
