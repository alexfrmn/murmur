import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileOutboxStore, SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";

const envelopeFor = (msgId) => ({
  schemaVersion: "1.0",
  msgId,
  conversationId: "conv-1",
  senderAgentId: "agent.a",
  recipients: ["agent.b"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("x").toString("base64"),
  payloadNonce: "nonce",
  signature: "sig",
});

const stores = [
  ["SQLiteDedupeOutboxStore", () => new SQLiteDedupeOutboxStore(join(mkdtempSync(join(tmpdir(), "murmur-outbox-")), "murmur.db"))],
  ["JsonFileOutboxStore", () => new JsonFileOutboxStore(join(mkdtempSync(join(tmpdir(), "murmur-outbox-")), "outbox.json"))],
];

for (const [label, makeStore] of stores) {
  // #113: claimDue() selects `failed` rows on purpose, so the retry has to be able to
  // finish. While `failed` counted as terminal, markSent() refused the claimed row:
  // status stayed `failed`, attempts never grew (so maxAttempts/DLQ never fired),
  // nextAttemptAt stayed in the past, and the row was re-claimed on every flush.
  test(`${label}: a retried failed row reaches sent and can settle`, async () => {
    const store = makeStore();
    const envelope = envelopeFor("msg-retry");

    await store.enqueue("agent.b", envelope);
    await store.markFailed(envelope.msgId, "publish-failed", new Date(Date.now() - 1000).toISOString());

    const [claimed] = await store.claimDue(10);
    assert.equal(claimed.status, "failed");

    await store.markSent(claimed.msgId, claimed.version);

    const afterSend = await store.getOutboxRecord(envelope.msgId);
    assert.equal(afterSend.status, "sent");
    assert.equal(afterSend.attempts, claimed.attempts + 1, "attempts must grow, or DLQ never fires");

    // The returning ACK is now accepted instead of bouncing as message-not-in-flight.
    assert.equal(await store.applyAckTransition(envelope.msgId, "ack"), "applied");
    assert.equal((await store.getOutboxRecord(envelope.msgId)).status, "acked");
    assert.equal((await store.claimDue(10)).length, 0);
  });

  // The race #109 fixed, re-checked against the version guard that replaced the
  // status list: an ACK/NACK landing between publish() and markSent() must win.
  test(`${label}: a verdict that lands mid-publish is not overwritten by a late markSent`, async () => {
    const store = makeStore();
    const envelope = envelopeFor("msg-race");

    await store.enqueue("agent.b", envelope);
    const [claimed] = await store.claimDue(10);

    // ...publish() is in flight here; the peer NACKs before markSent() runs.
    assert.equal(await store.applyAckTransition(envelope.msgId, "nack", "peer-said-no"), "applied");
    await store.markSent(claimed.msgId, claimed.version);

    const row = await store.getOutboxRecord(envelope.msgId);
    assert.equal(row.status, "failed", "the late markSent must not drag the row back into flight");
    assert.equal(row.lastError, "peer-said-no");
  });

  test(`${label}: a settled row is never resurrected, with or without a version`, async () => {
    const store = makeStore();
    const envelope = envelopeFor("msg-settled");

    await store.enqueue("agent.b", envelope);
    const [claimed] = await store.claimDue(10);
    await store.markAcked(envelope.msgId);

    await store.markSent(claimed.msgId, claimed.version);
    await store.markSent(claimed.msgId);

    assert.equal((await store.getOutboxRecord(envelope.msgId)).status, "acked");
  });
}
