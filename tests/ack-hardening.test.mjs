// Regression tests for the signed-ACK hardening in #109.
//
// Each test below fails on the pre-#109 code and passes after it. They cover the gaps that
// #100 (compatible signed ACKs) left open and that #104 (wire-breaking) would have closed
// at the cost of a mesh-wide flag day.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryAckReceiptStore,
  JsonFileOutboxStore,
  SQLiteDedupeOutboxStore,
  TERMINAL_OUTBOX_STATUSES,
} from "@murmurv2/core";

const workdir = () => mkdtempSync(path.join(tmpdir(), "murmur-ack-"));

const envelope = (msgId) => ({
  schemaVersion: "1.0",
  msgId,
  conversationId: "conv-1",
  senderAgentId: "agent-a",
  recipients: ["agent-b"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: "x",
  payloadNonce: "y",
  signature: "z",
});

// --- Gap 1: replay protection must survive a restart -------------------------------
//
// The pre-#109 broker held nonces in a bounded in-memory Set. A restart forgot them, so a
// signed NACK could be replayed against a fresh process: the retry returned the row to
// `sent` and the replayed NACK failed it again.

test("SQLite ack receipts: a nonce can be claimed exactly once", async () => {
  const dir = workdir();
  try {
    const store = new SQLiteDedupeOutboxStore(path.join(dir, "murmur.db"));
    assert.equal(await store.claimAckNonce("agent-b", "nonce-1"), true);
    assert.equal(await store.claimAckNonce("agent-b", "nonce-1"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite ack receipts: a claim survives a restart of the process", async () => {
  const dir = workdir();
  const dbPath = path.join(dir, "murmur.db");
  try {
    const before = new SQLiteDedupeOutboxStore(dbPath);
    assert.equal(await before.claimAckNonce("agent-b", "nonce-replay"), true);

    // A brand-new store instance stands in for a restarted daemon: same file, no shared
    // memory. This is precisely where the in-memory Set used to forget.
    const after = new SQLiteDedupeOutboxStore(dbPath);
    assert.equal(await after.claimAckNonce("agent-b", "nonce-replay"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite ack receipts: the same nonce from a different sender is a different claim", async () => {
  const dir = workdir();
  try {
    const store = new SQLiteDedupeOutboxStore(path.join(dir, "murmur.db"));
    assert.equal(await store.claimAckNonce("agent-b", "shared-nonce"), true);
    assert.equal(await store.claimAckNonce("agent-c", "shared-nonce"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InMemoryAckReceiptStore keeps claim-once semantics within a process", async () => {
  const store = new InMemoryAckReceiptStore(4);
  assert.equal(await store.claimAckNonce("agent-b", "n1"), true);
  assert.equal(await store.claimAckNonce("agent-b", "n1"), false);
});

// --- Gap 2: the fast-ACK race --------------------------------------------------------
//
// A peer can acknowledge between publish() and markSent(). The pre-#109 code required
// status === 'sent', rejected the ACK as `message-not-in-flight`, and left the row to time
// out into a spurious retry.

for (const [label, makeStore] of [
  ["SQLite", (dir) => new SQLiteDedupeOutboxStore(path.join(dir, "murmur.db"))],
  ["JSON", (dir) => new JsonFileOutboxStore(path.join(dir, "outbox.json"))],
]) {
  test(`${label} outbox: an ACK arriving while the row is still pending is applied`, async () => {
    const dir = workdir();
    try {
      const store = makeStore(dir);
      await store.enqueue("msg.agent-b", envelope("m-fast"));

      // No markSent() yet — this is the race window.
      assert.equal(await store.applyAckTransition("m-fast", "ack"), "applied");

      const record = await store.getOutboxRecord("m-fast");
      assert.equal(record.status, "acked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${label} outbox: a late markSent does not resurrect an acked row`, async () => {
    const dir = workdir();
    try {
      const store = makeStore(dir);
      await store.enqueue("msg.agent-b", envelope("m-late"));
      await store.applyAckTransition("m-late", "ack");

      // The publisher's markSent() lands after the ACK was already applied.
      await store.markSent("m-late");

      const record = await store.getOutboxRecord("m-late");
      assert.equal(record.status, "acked", "a settled row must not be dragged back to sent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${label} outbox: a terminal row still rejects a second transition`, async () => {
    const dir = workdir();
    try {
      const store = makeStore(dir);
      await store.enqueue("msg.agent-b", envelope("m-twice"));
      await store.markSent("m-twice");
      assert.equal(await store.applyAckTransition("m-twice", "ack"), "applied");
      assert.equal(await store.applyAckTransition("m-twice", "nack"), "not-in-flight");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("terminal statuses are the ones markSent must refuse to downgrade", () => {
  assert.equal(TERMINAL_OUTBOX_STATUSES.has("acked"), true);
  assert.equal(TERMINAL_OUTBOX_STATUSES.has("failed"), true);
  assert.equal(TERMINAL_OUTBOX_STATUSES.has("dlq"), true);
  assert.equal(TERMINAL_OUTBOX_STATUSES.has("pending"), false);
  assert.equal(TERMINAL_OUTBOX_STATUSES.has("sent"), false);
});
