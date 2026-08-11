import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import {
  SQLiteDedupeOutboxStore,
  createAck,
  stableAckPayload,
} from "../packages/core/dist/src/index.js";
import {
  createSigningKeyPair,
  signEnvelope,
  verifyEnvelopeSignature,
} from "../packages/security/dist/src/index.js";

const envelope = {
  schemaVersion: "1.0",
  msgId: "msg-int-1",
  conversationId: "conv-1",
  senderAgentId: "agent.a",
  recipients: ["agent.b"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("x").toString("base64"),
  payloadNonce: "nonce",
  signature: "sig",
};

test("ack correlation handles nack as immediate failed requeue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-int-"));
  const dbPath = join(dir, "murmur.db");
  const store = new SQLiteDedupeOutboxStore(dbPath);
  const senderKeys = await createSigningKeyPair();
  const receiverKeys = await createSigningKeyPair();
  const broker = new NatsBroker({
    url: process.env.NATS_URL ?? "nats://127.0.0.1:4222",
    ackSecurity: {
      localAgentId: "agent.a",
      sign: (payload) => signEnvelope(payload, senderKeys.privateKey),
      verify: (senderAgentId, payload, signature) =>
        senderAgentId === "agent.b"
          ? verifyEnvelopeSignature(payload, signature, receiverKeys.publicKey)
          : Promise.resolve(false),
    },
  });

  await store.enqueue("msg.demo.secure", envelope);
  await store.markSent(envelope.msgId);

  const sub = await broker.startAckCorrelation({
    outbox: store,
    ackSubject: "ack.agent.a",
  });

  const ack = createAck(envelope, "integration", "agent.b", "nack", "forced-nack");
  ack.signature = await signEnvelope(stableAckPayload(ack), receiverKeys.privateKey);
  const publisher = new NatsBroker({
    url: process.env.NATS_URL ?? "nats://127.0.0.1:4222",
    ackSecurity: {
      localAgentId: "agent.b",
      sign: (payload) => signEnvelope(payload, receiverKeys.privateKey),
      verify: async () => false,
    },
  });
  await publisher.publishAck("ack.agent.a", ack);

  await new Promise((r) => setTimeout(r, 150));
  const due = await store.claimDue(10);
  assert.equal(due.length, 1);
  assert.equal(due[0].status, "failed");
  assert.equal(due[0].lastError, "forced-nack");

  sub.unsubscribe();
  await publisher.close();
  await broker.close();
});
