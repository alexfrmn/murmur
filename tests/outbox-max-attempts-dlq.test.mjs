import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import { SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";

const envelope = {
  schemaVersion: "1.0",
  msgId: "msg-absent-1",
  conversationId: "conv-1",
  senderAgentId: "agent.a",
  recipients: ["agent.absent"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("x").toString("base64"),
  payloadNonce: "nonce",
  signature: "sig",
};

// A receiver that is not on the mesh never ACKs. Every flush publishes fine, the row goes
// `sent`, the ACK timeout drags it back to `failed`, and the next flush publishes it again.
// Nothing ever throws, so the publish-error path that enforces maxAttempts never runs:
// observed on VM105 as one row at attempts=32, still cycling. The cap has to hold on the
// success path too.
test("flushOutbox dead-letters a row that keeps timing out on ACK once maxAttempts is reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-maxattempts-"));
  const dbPath = join(dir, "murmur.db");
  const outbox = new SQLiteDedupeOutboxStore(dbPath);
  const published = [];
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  broker.nc = {
    publish(subject) { published.push(subject); },
    async jetstreamManager() { throw new Error("jetstream-manager-should-not-be-called"); },
    async drain() {},
  };

  await outbox.enqueue("msg.agent-absent", envelope);
  for (let i = 0; i < 8; i += 1) {
    await broker.flushOutbox({ outbox, maxAttempts: 3, ackTimeoutMs: 1 });
    await new Promise((r) => setTimeout(r, 5)); // let the `sent` row go stale
  }

  const row = new DatabaseSync(dbPath)
    .prepare("SELECT status, attempts, last_error FROM outbox WHERE msg_id = ?")
    .get(envelope.msgId);
  assert.equal(row.status, "dlq");
  assert.equal(published.length, 3, "publishes stop at maxAttempts");
  assert.match(String(row.last_error), /max-attempts/);
});
