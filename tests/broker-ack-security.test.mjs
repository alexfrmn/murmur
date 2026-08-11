import test from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import { createAck, stableAckPayload } from "../packages/core/dist/src/index.js";
import {
  createSigningKeyPair,
  signEnvelope,
  verifyEnvelopeSignature,
} from "../packages/security/dist/src/index.js";

const sc = StringCodec();
const senderKeys = await createSigningKeyPair();
const receiverKeys = await createSigningKeyPair();
const malloryKeys = await createSigningKeyPair();

const envelope = Object.freeze({
  schemaVersion: "1.0",
  msgId: "known-message-id",
  conversationId: "known-conversation",
  senderAgentId: "sender",
  recipients: ["receiver"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: "ciphertext",
  payloadNonce: "nonce",
  signature: "envelope-signature",
});

class MemoryOutbox {
  constructor() {
    this.record = {
      msgId: envelope.msgId,
      subject: "msg.receiver",
      envelope,
      status: "sent",
      attempts: 1,
      nextAttemptAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.receipts = new Set();
    this.transitions = [];
  }

  async get(msgId) {
    return msgId === this.record.msgId ? this.record : undefined;
  }

  async applyVerifiedAck(ack) {
    if (this.receipts.has(ack.ackId)) return "replay";
    if (this.record.status === "acked" || this.record.status === "dlq") return "terminal";
    this.receipts.add(ack.ackId);
    this.record.status = ack.status === "ack" ? "acked" : "failed";
    this.transitions.push([ack.status, ack.msgId]);
    return "applied";
  }
}

function brokerHarness() {
  const rejected = [];
  const publicKeys = {
    receiver: receiverKeys.publicKey,
    mallory: malloryKeys.publicKey,
  };
  const broker = new NatsBroker({
    url: "nats://example.invalid",
    ackSecurity: {
      localAgentId: "sender",
      sign: (payload) => signEnvelope(payload, senderKeys.privateKey),
      verify: (senderAgentId, payload, signature) => {
        const key = publicKeys[senderAgentId];
        return key ? verifyEnvelopeSignature(payload, signature, key) : Promise.resolve(false);
      },
      onRejected: (event) => rejected.push(event),
    },
  });
  return { broker, rejected };
}

async function signedAck(overrides = {}, privateKey = receiverKeys.privateKey) {
  const ack = Object.assign(createAck(envelope, "receiver-consumer", "receiver", "ack"), overrides);
  ack.signature = await signEnvelope(stableAckPayload(ack), privateKey);
  return ack;
}

async function process(broker, outbox, ack) {
  await broker.processAckFrame(sc.encode(JSON.stringify(ack)), outbox);
}

test("unsigned ACKs cannot transition the outbox", async () => {
  const { broker, rejected } = brokerHarness();
  const outbox = new MemoryOutbox();
  await process(broker, outbox, {
    msgId: envelope.msgId,
    consumerId: "claimed-peer",
    status: "ack",
    at: new Date().toISOString(),
  });
  assert.deepEqual(outbox.transitions, []);
  assert.equal(rejected[0].reason, "unsigned-or-invalid");
});

test("a valid signed and bound ACK transitions exactly once", async () => {
  const { broker } = brokerHarness();
  const outbox = new MemoryOutbox();
  await process(broker, outbox, await signedAck());
  assert.deepEqual(outbox.transitions, [["ack", envelope.msgId]]);
  assert.equal(outbox.record.status, "acked");
});

test("wrong peer, conversation, digest, and recipient bindings are rejected", async () => {
  for (const ackFactory of [
    () => signedAck({ senderAgentId: "mallory" }, malloryKeys.privateKey),
    () => signedAck({ conversationId: "other-conversation" }),
    () => signedAck({ messageDigest: "b".repeat(64) }),
    () => signedAck({ recipientAgentId: "other-sender" }),
  ]) {
    const { broker, rejected } = brokerHarness();
    const outbox = new MemoryOutbox();
    await process(broker, outbox, await ackFactory());
    assert.deepEqual(outbox.transitions, []);
    assert.equal(rejected.at(-1).reason, "binding-mismatch");
  }
});

test("an ACK signed by an untrusted key is rejected", async () => {
  const { broker, rejected } = brokerHarness();
  const outbox = new MemoryOutbox();
  await process(broker, outbox, await signedAck({}, malloryKeys.privateKey));
  assert.deepEqual(outbox.transitions, []);
  assert.equal(rejected.at(-1).reason, "signature-invalid");
});

test("replaying one valid signed ACK creates no second transition", async () => {
  const { broker, rejected } = brokerHarness();
  const outbox = new MemoryOutbox();
  const ack = await signedAck();
  await process(broker, outbox, ack);
  // Keep the row non-terminal to prove ackId persistence, not terminal status, blocks it.
  outbox.record.status = "sent";
  await process(broker, outbox, ack);
  assert.deepEqual(outbox.transitions, [["ack", envelope.msgId]]);
  assert.equal(rejected.at(-1).reason, "replay");
});

test("stale signed ACKs are rejected before correlation", async () => {
  const { broker, rejected } = brokerHarness();
  const outbox = new MemoryOutbox();
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  await process(broker, outbox, await signedAck({ at: old }));
  assert.deepEqual(outbox.transitions, []);
  assert.equal(rejected.at(-1).reason, "stale-or-future");
});

test("a valid signed NACK preserves legitimate retry behavior", async () => {
  const { broker } = brokerHarness();
  const outbox = new MemoryOutbox();
  await process(broker, outbox, await signedAck({ status: "nack", reason: "handler-down" }));
  assert.deepEqual(outbox.transitions, [["nack", envelope.msgId]]);
  assert.equal(outbox.record.status, "failed");
});

test("invalid ACK alerts contain metadata but never raw frame contents", async () => {
  const { broker } = brokerHarness();
  const outbox = new MemoryOutbox();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await process(broker, outbox, { msgId: envelope.msgId, rawSecret: "DO-NOT-LOG-ME" });
  } finally {
    console.warn = original;
  }
  assert.equal(JSON.stringify(warnings).includes("DO-NOT-LOG-ME"), false);
  assert.equal(broker.getAckRejectionCounts()["unsigned-or-invalid"], 1);
});

test("ACK correlation and publishing enforce the local per-agent subject", async () => {
  const { broker } = brokerHarness();
  const outbox = new MemoryOutbox();
  await assert.rejects(
    () => broker.startAckCorrelation({ outbox, ackSubject: "ack.someone-else" }),
    /ack-subject-mismatch/,
  );

  const claimedRemoteAck = await signedAck();
  await assert.rejects(
    () => broker.publishAck("ack.sender", claimedRemoteAck),
    /ack-sender-mismatch/,
  );

  const localAck = createAck(envelope, "sender-consumer", "sender", "ack");
  localAck.signature = await signEnvelope(stableAckPayload(localAck), senderKeys.privateKey);
  await assert.rejects(
    () => broker.publishAck("ack.someone-else", localAck),
    /ack-subject-mismatch/,
  );
});
