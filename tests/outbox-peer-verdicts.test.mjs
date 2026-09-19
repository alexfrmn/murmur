import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringCodec } from "nats";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import { JsonFileOutboxStore, SQLiteDedupeOutboxStore, createBoundAck, stableAckPayload } from "../packages/core/dist/src/index.js";
import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from "../packages/security/dist/src/index.js";

const sc = StringCodec();
const envelope = {
  schemaVersion: "1.0", msgId: "msg-peer-verdict", conversationId: "conv-peer-verdict",
  senderAgentId: "agent-sender", recipients: ["agent-receiver"],
  createdAt: new Date().toISOString(), payloadCiphertext: Buffer.from("x").toString("base64"),
  payloadNonce: "nonce", signature: "sig",
};

for (const Store of [JsonFileOutboxStore, SQLiteDedupeOutboxStore]) {
  const setup = (t) => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-peer-verdict-"));
    const store = new Store(join(dir, "state"));
    t.after(() => { store.db?.close(); rmSync(dir, { recursive: true, force: true }); });
    return store;
  };

  test(`${Store.name}: a signed terminal peer verdict settles a failed row (#142)`, async (t) => {
    const outbox = setup(t);
    const signing = await createSigningKeyPair();
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    const errors = [];
    const send = async (status, reason) => {
      const unsigned = createBoundAck(envelope, "agent-receiver", status, reason);
      const ack = { ...unsigned, signature: await signEnvelope(stableAckPayload(unsigned), signing.privateKey) };
      await broker.processAckFrame(sc.encode(JSON.stringify(ack)), {
        outbox, requireSignedAcks: true,
        verifyAck: (candidate) => verifyEnvelopeSignature(stableAckPayload(candidate), candidate.signature, signing.publicKey),
        onInvalidAck: (event) => errors.push(event.reason),
      });
    };
    await outbox.enqueue("msg.agent-receiver", envelope);
    await outbox.markSent(envelope.msgId);
    await send("nack", "missing-column");
    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "failed");
    await send("nack", "still-missing-column");
    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).lastError, "still-missing-column");
    await send("nack", "poison-message:missing-column");
    const settled = await outbox.getOutboxRecord(envelope.msgId);
    assert.equal(settled.status, "dlq");
    assert.equal(settled.lastError, "poison-message:missing-column");
    assert.deepEqual(errors, []);
    await send("ack");
    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).version, settled.version);
    assert.deepEqual(errors, ["message-not-in-flight"]);
    assert.deepEqual(await outbox.claimDue(), []);
  });

  test(`${Store.name}: a delayed ACK settles failed without another publish (#142)`, async (t) => {
    const outbox = setup(t);
    await outbox.enqueue("msg.agent-receiver", envelope);
    await outbox.markFailed(envelope.msgId, "ack-timeout", new Date().toISOString());
    assert.equal(await outbox.applyAckTransition(envelope.msgId, "ack"), "applied");
    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "acked");
  });

  test(`${Store.name}: repeated timeouts retain the peer's diagnosis through DLQ (#143)`, async (t) => {
    const outbox = setup(t);
    await outbox.enqueue("msg.agent-receiver", envelope);
    await outbox.applyAckTransition(envelope.msgId, "nack", "missing-column");
    for (let i = 0; i < 2; i += 1) {
      await outbox.markSent(envelope.msgId);
      assert.equal(await outbox.requeueStaleSent(0), 1);
      assert.equal((await outbox.getOutboxRecord(envelope.msgId)).lastError, "missing-column");
    }
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    broker.publish = async () => assert.fail("exhausted row must not publish");
    await broker.flushOutbox({ outbox, maxAttempts: 2 });
    const row = await outbox.getOutboxRecord(envelope.msgId);
    assert.equal(row.status, "dlq");
    assert.equal(row.lastError, "max-attempts:missing-column");
  });

  test(`${Store.name}: retry crosses JetStream dedupe while the envelope stays identical (#141)`, async (t) => {
    const outbox = setup(t);
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    const ids = new Set();
    const deliveries = [];
    // Model the server's duplicate window: a repeated transport ID succeeds but
    // does not deliver. Use the real publish and flushOutbox paths above that boundary.
    broker.connect = async () => {};
    broker.js = {
      async publish(subject, data, { msgID }) {
        const duplicate = ids.has(msgID);
        ids.add(msgID);
        if (!duplicate) deliveries.push({ subject, envelope: JSON.parse(sc.decode(data)) });
        return { duplicate };
      },
    };
    await outbox.enqueue("msg.agent-receiver", envelope);
    await broker.flushOutbox({ outbox });
    await outbox.requeueStaleSent(0);
    await broker.flushOutbox({ outbox });
    assert.equal(deliveries.length, 2, "ACK-timeout retry must reach the receiver inside dup_window");
    assert.deepEqual(deliveries.map((x) => x.envelope), [envelope, envelope]);
    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).attempts, 2);
  });

  test(`${Store.name}: fast NACK retry advances transport ID even when attempts did not advance (#141)`, async (t) => {
    const outbox = setup(t);
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    const ids = [];
    broker.connect = async () => {};
    broker.js = { async publish(_subject, _data, { msgID }) {
      ids.push(msgID);
      await outbox.applyAckTransition(envelope.msgId, "nack", "peer-busy");
    } };
    await outbox.enqueue("msg.agent-receiver", envelope);
    await broker.flushOutbox({ outbox });
    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).attempts, 0, "fast NACK wins the markSent CAS");
    await broker.flushOutbox({ outbox });
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
}

for (const outcome of ["delivered", "duplicate", "poison", "recoverable", "unauthorized", "malformed"]) {
  test(`proxy ${outcome}: no delivery ACK impersonates the addressee (#144)`, async () => {
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    const acks = [];
    let delivered = 0;
    broker.publishAck = async (...args) => acks.push(args);
    const result = await broker.processEnvelopeFrame(
      sc.encode(JSON.stringify(outcome === "malformed" ? {} : envelope)),
      {
        consumerId: "agent-proxy", emitDeliveryAcks: false, maxPoisonAttempts: 1,
        dedupe: { async seen() { return outcome === "duplicate"; }, async markSeen() {} },
        authorize: async () => ({ accepted: outcome !== "unauthorized", reason: "denied" }),
        onMessage: async () => {
          delivered += 1;
          if (outcome === "poison") throw new Error("missing-column");
          if (outcome === "recoverable") throw new Error("unknown-sender:agent-sender");
        },
      },
    );
    assert.equal(acks.length, 0);
    if (outcome === "delivered") assert.equal(delivered, 1);
    assert.equal(result, outcome === "recoverable" ? "retry" : "ack", "JetStream disposition is independent of delivery ACKs");
  });
}
