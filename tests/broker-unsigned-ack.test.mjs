import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringCodec } from "nats";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import { JsonFileOutboxStore, SQLiteDedupeOutboxStore, SQLiteMessageStore, createBoundAck, stableAckPayload } from "../packages/core/dist/src/index.js";
import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from "../packages/security/dist/src/index.js";

const sc = StringCodec();
const envelope = {
  schemaVersion: "1.0", msgId: "unsigned-race", conversationId: "ack-incident",
  senderAgentId: "sender", recipients: ["receiver"], createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("encrypted").toString("base64"), payloadNonce: "nonce", signature: "signature",
};
function setup(t, Store) {
  const dir = mkdtempSync(join(tmpdir(), "murmur-unsigned-ack-"));
  const outbox = new Store(join(dir, "state"));
  t.after(() => { outbox.db?.close(); rmSync(dir, { recursive: true, force: true }); });
  return outbox;
}

test("receiver signs success only after durable inbox commit; failed persistence sends only NACK", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-receive-commit-"));
  const store = new SQLiteMessageStore(join(dir, "receiver.db"));
  const dedupe = new SQLiteDedupeOutboxStore(join(dir, "receiver.db"));
  t.after(() => { store.db.close(); dedupe.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const keys = await createSigningKeyPair();
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  const acks = [];
  broker.publishAck = async (_subject, ack) => {
    assert.equal(await verifyEnvelopeSignature(stableAckPayload(ack), ack.signature, keys.publicKey), true);
    if (ack.status === "ack") {
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM local_messages WHERE msg_id=?").get(envelope.msgId).n, 1);
    }
    acks.push(ack);
  };
  const options = {
    consumerId: "receiver", dedupe,
    signAck: async (ack) => ({ ...ack, signature: await signEnvelope(stableAckPayload(ack), keys.privateKey) }),
    onMessage: async (e) => {
      await store.append({ msgId: e.msgId, conversationId: e.conversationId, direction: "inbound",
        sender: e.senderAgentId, text: "decoded", createdAt: e.createdAt, wakeEligible: true });
    },
  };
  store.db.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON local_messages BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
  await broker.processEnvelopeFrame(sc.encode(JSON.stringify(envelope)), options);
  assert.deepEqual(acks.map((a) => a.status), ["nack"]);
  assert.equal(await dedupe.seen(envelope.msgId, "receiver"), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM local_messages").get().n, 0);
  store.db.exec("DROP TRIGGER fail_inbox");
  await broker.processEnvelopeFrame(sc.encode(JSON.stringify(envelope)), options);
  assert.deepEqual(acks.map((a) => a.status), ["nack", "ack"]);
});
for (const Store of [JsonFileOutboxStore, SQLiteDedupeOutboxStore]) {
  for (const requireSignedAcks of [undefined, false, true]) {
    test(`${Store.name}: unsigned ACK/NACK cannot mutate rows with requireSignedAcks=${requireSignedAcks}`, async (t) => {
      const outbox = setup(t, Store);
      await outbox.enqueue("msg.receiver", envelope);
      await outbox.markSent(envelope.msgId);
      const before = await outbox.getOutboxRecord(envelope.msgId);
      const broker = new NatsBroker({ url: "nats://example.invalid" });
      const events = [];
      const params = { outbox, requireSignedAcks, onInvalidAck: (e) => events.push(e.reason),
        verifyAck: async () => assert.fail("unsigned frames cannot reach signature verification") };
      for (const frame of [
        { msgId: envelope.msgId, status: "ack" },
        { msgId: envelope.msgId, status: "nack", reason: "poison-message:forged" },
        { ...createBoundAck(envelope, "receiver", "ack"), signature: "" },
        null, [], {}, "invalid",
      ]) {
        await broker.processAckFrame(sc.encode(JSON.stringify(frame)), params);
        assert.deepEqual(await outbox.getOutboxRecord(envelope.msgId), before);
      }
      assert.deepEqual(events, Array(7).fill("unsigned-or-malformed"));
    });
  }

  test(`${Store.name}: six unsigned ACKs cannot conceal the signed receiver storage failure`, async (t) => {
    const outbox = setup(t, Store);
    await outbox.enqueue("msg.receiver", envelope);
    await outbox.markSent(envelope.msgId);
    const keys = await createSigningKeyPair();
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    const params = { outbox, requireSignedAcks: false,
      verifyAck: (a) => verifyEnvelopeSignature(stableAckPayload(a), a.signature, keys.publicKey) };
    const process = (frame) => broker.processAckFrame(sc.encode(JSON.stringify(frame)), params);
    const signed = async (status, reason) => {
      const ack = createBoundAck(envelope, "receiver", status, reason);
      return { ...ack, signature: await signEnvelope(stableAckPayload(ack), keys.privateKey) };
    };
    await process({ msgId: envelope.msgId, status: "ack" });
    await process(await signed("nack", "database is locked"));
    for (let i = 0; i < 5; i++) await process({ msgId: envelope.msgId, status: "ack" });
    const failed = await outbox.getOutboxRecord(envelope.msgId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "database is locked");
    await process(await signed("ack"));
    const settled = await outbox.getOutboxRecord(envelope.msgId);
    assert.equal(settled.status, "acked");
    // A failed duplicate receive does not invalidate an earlier signed durable receipt.
    await process(await signed("nack", "database is locked"));
    assert.deepEqual(await outbox.getOutboxRecord(envelope.msgId), settled);
  });
}
