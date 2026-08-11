import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonFileOutboxStore,
  SQLiteDedupeOutboxStore,
  createAck,
} from "../dist/src/index.js";

const envelope = Object.freeze({
  schemaVersion: "1.0",
  msgId: "persistent-ack-message",
  conversationId: "persistent-ack-conversation",
  senderAgentId: "sender",
  recipients: ["receiver"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: "ciphertext",
  payloadNonce: "nonce",
  signature: "envelope-signature",
});

function nack() {
  const ack = createAck(envelope, "receiver-consumer", "receiver", "nack", "retry-me");
  ack.signature = "verified-before-store";
  return ack;
}

async function provePersistentReplayProtection(makeStore) {
  const first = makeStore();
  await first.enqueue("msg.receiver", envelope);
  await first.markSent(envelope.msgId);

  const ack = nack();
  assert.equal(await first.applyVerifiedAck(ack), "applied");
  assert.equal((await first.get(envelope.msgId)).status, "failed");

  // Simulate a retry plus process restart. The durable receipt, rather than the
  // current outbox status, must prevent the same signed ACK from transitioning it.
  await first.markSent(envelope.msgId);
  const reopened = makeStore();
  assert.equal(await reopened.applyVerifiedAck(ack), "replay");
  assert.equal((await reopened.get(envelope.msgId)).status, "sent");
}

test("SQLite outbox persists ACK nonces across retries and process restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-ack-sqlite-"));
  const dbPath = join(dir, "murmur.db");
  await provePersistentReplayProtection(() => new SQLiteDedupeOutboxStore(dbPath));
});

test("JSON outbox persists ACK nonces across retries and process restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-ack-json-"));
  const filePath = join(dir, "outbox.json");
  await provePersistentReplayProtection(() => new JsonFileOutboxStore(filePath));
});

for (const [name, makeStore] of [
  ["SQLite", () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-fast-ack-sqlite-"));
    return new SQLiteDedupeOutboxStore(join(dir, "murmur.db"));
  }],
  ["JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-fast-ack-json-"));
    return new JsonFileOutboxStore(join(dir, "outbox.json"));
  }],
]) {
  test(`${name} outbox does not overwrite an ACK that arrives before markSent`, async () => {
    const store = makeStore();
    await store.enqueue("msg.receiver", envelope);
    const ack = createAck(envelope, "receiver-consumer", "receiver", "ack");
    ack.signature = "verified-before-store";
    assert.equal(await store.applyVerifiedAck(ack), "applied");
    await store.markSent(envelope.msgId);
    assert.equal((await store.get(envelope.msgId)).status, "acked");
  });
}
