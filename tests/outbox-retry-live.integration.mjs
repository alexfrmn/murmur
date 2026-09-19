import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import { SQLiteDedupeOutboxStore, stableAckPayload } from "../packages/core/dist/src/index.js";
import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from "../packages/security/dist/src/index.js";

const until = async (predicate) => {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail("condition not reached within 5 seconds");
};

test("isolated JetStream: lost signed ACK retries inside dup_window and settles exactly once", { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-outbox-live-"));
  const server = spawn("nats-server", ["-a", "127.0.0.1", "-p", "-1", "-js", "-sd", join(dir, "jetstream")], { stdio: ["ignore", "ignore", "pipe"] });
  const brokers = [];
  const stores = [];
  const subscriptions = [];
  t.after(async () => {
    for (const sub of subscriptions) await sub.unsubscribe();
    for (const broker of brokers) await broker.close();
    for (const store of stores) store.db.close();
    if (server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
    rmSync(dir, { recursive: true, force: true });
  });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`isolated-nats-exited:${code}`)));
    server.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const port = output.match(/Listening for client connections on 127\.0\.0\.1:(\d+)/)?.[1];
      if (port) resolve(`nats://127.0.0.1:${port}`);
    });
  });
  const sender = new NatsBroker({ url, jetstream: true, stream: "RETRY_TEST", streamSubjects: ["msg.>", "ack.>"] });
  const receiver = new NatsBroker({ url, jetstream: true, stream: "RETRY_TEST", streamSubjects: ["msg.>", "ack.>"] });
  brokers.push(sender, receiver);
  await sender.connect();
  await receiver.connect();
  const outbox = new SQLiteDedupeOutboxStore(join(dir, "sender.db"));
  const dedupe = new SQLiteDedupeOutboxStore(join(dir, "receiver.db"));
  stores.push(outbox, dedupe);
  const keys = await createSigningKeyPair();
  let handlerCalls = 0;
  let deliveryAcks = 0;
  let transportDeliveries = 0;
  const publishAck = receiver.publishAck.bind(receiver);
  receiver.publishAck = async (...args) => {
    deliveryAcks += 1;
    if (deliveryAcks === 1) return; // Lose the first ACK after durable receiver dedupe.
    return publishAck(...args);
  };
  subscriptions.push(await sender.startAckCorrelation({
    outbox, ackReceipts: outbox, ackSubject: "ack.sender", consumerId: "sender-ack",
    requireSignedAcks: true,
    verifyAck: (ack) => verifyEnvelopeSignature(stableAckPayload(ack), ack.signature, keys.publicKey),
  }));
  subscriptions.push(await receiver.subscribeRaw("msg.receiver", () => { transportDeliveries += 1; }));
  subscriptions.push(await receiver.subscribeWithAck({
    subject: "msg.receiver", consumerId: "receiver", dedupe,
    onMessage: async () => { handlerCalls += 1; },
    signAck: async (ack) => ({ ...ack, signature: await signEnvelope(stableAckPayload(ack), keys.privateKey) }),
  }));
  const envelope = {
    schemaVersion: "1.0", msgId: "retry-live", conversationId: "retry-proof",
    senderAgentId: "sender", recipients: ["receiver"], createdAt: new Date().toISOString(),
    payloadCiphertext: Buffer.from("payload").toString("base64"), payloadNonce: "nonce", signature: "sig",
  };
  await outbox.enqueue("msg.receiver", envelope);
  const start = Date.now();
  await sender.flushOutbox({ outbox });
  await until(() => deliveryAcks === 1);
  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "sent");
  await outbox.requeueStaleSent(0);
  await sender.flushOutbox({ outbox });
  await until(async () => (await outbox.getOutboxRecord(envelope.msgId)).status === "acked");
  assert.equal(handlerCalls, 1, "receiver handler executes only once");
  assert.equal(transportDeliveries, 2, "retry reaches JetStream consumer despite duplicate window");
  assert.equal(deliveryAcks, 2, "duplicate delivery emits the replacement signed ACK");
  const info = await sender.jsm.streams.info("RETRY_TEST");
  assert.ok(Date.now() - start < info.config.duplicate_window / 1e6);
  console.log(JSON.stringify({ isolated: true, handlerCalls, transportDeliveries, deliveryAcks, status: "acked", duplicateWindowMs: info.config.duplicate_window / 1e6 }));
});
