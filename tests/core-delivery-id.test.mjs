import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";

// #105 — the receiving side keeps one durable row per delivery. `delivery_id` is minted
// once by the sender (it is the envelope msgId, which never changes across retries) and
// is UNIQUE per direction on the receiver, so a redelivered envelope lands on the row that
// already exists instead of producing a second one — and a second wake.

const withStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-delivery-"));
  const dbPath = join(dir, "murmur.db");
  const store = new SQLiteMessageStore(dbPath);
  return {
    store,
    dbPath,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const inbound = (store, msgId, extra = {}) =>
  store.append({
    conversationId: "conv-1",
    msgId,
    direction: "inbound",
    sender: "agent-peer",
    text: `text ${msgId}`,
    createdAt: "2026-09-12T12:00:00.000Z",
    transport: "nats",
    ...extra,
  });

const rowsFor = (dbPath, msgId) => {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT COUNT(*) as n FROM local_messages WHERE msg_id = ?").get(msgId).n;
  } finally {
    db.close();
  }
};

test("append stores each inbound delivery once: a redelivered msgId is a duplicate, not a second row", async () => {
  const { store, dbPath, cleanup } = withStore();
  try {
    const first = await inbound(store, "m1");
    const second = await inbound(store, "m1");

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.rowid, first.rowid, "the duplicate resolves to the existing row");
    assert.equal(rowsFor(dbPath, "m1"), 1);
  } finally {
    cleanup();
  }
});

test("append keeps inbound and outbound copies of the same msgId apart", async () => {
  const { store, dbPath, cleanup } = withStore();
  try {
    const out = await store.append({
      conversationId: "conv-1",
      msgId: "self-1",
      direction: "outbound",
      sender: "agent-self",
      text: "to myself",
      createdAt: "2026-09-12T12:00:00.000Z",
    });
    const back = await inbound(store, "self-1", { sender: "agent-self" });

    assert.equal(out.duplicate, false);
    assert.equal(back.duplicate, false);
    assert.equal(rowsFor(dbPath, "self-1"), 2);
  } finally {
    cleanup();
  }
});

test("legacy rows without delivery_id are migrated in place and never re-woken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-delivery-legacy-"));
  const dbPath = join(dir, "murmur.db");
  let store;
  try {
    // The 2.8.x schema: eight columns, no wake state, no delivery id.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE local_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        transport TEXT
      );
      INSERT INTO local_messages VALUES ('a', 'conv-1', 'old-1', 'inbound', 'agent-peer', 'old one', '2026-09-01T00:00:00.000Z', 'nats');
      INSERT INTO local_messages VALUES ('b', 'conv-1', 'old-2', 'inbound', 'agent-peer', 'old two', '2026-09-01T00:01:00.000Z', 'nats');
    `);
    legacy.close();

    store = new SQLiteMessageStore(dbPath);
    const inspect = new DatabaseSync(dbPath);
    const columns = new Set(inspect.prepare("PRAGMA table_info(local_messages)").all().map((c) => c.name));
    inspect.close();
    assert.ok(columns.has("delivery_id"));
    assert.ok(columns.has("wake_status"));

    // Upgrading must not replay history: legacy rows are outside the wake queue, and the
    // cursor already sits at the tip — the same seeding rule wake-drain uses.
    assert.deepEqual(await store.listOpenWakes(), []);
    assert.equal(await store.wakeCursor(), 2);

    const fresh = await inbound(store, "new-3");
    const open = await store.listOpenWakes();
    assert.deepEqual(open.map((r) => r.msgId), ["new-3"]);
    assert.equal(open[0].rowid, fresh.rowid);
    assert.equal(await store.wakeCursor(), 2, "an open delivery holds the cursor below it");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inbound rows enter the wake queue as pending; wake-ineligible rows are muted on arrival", async () => {
  const { store, cleanup } = withStore();
  try {
    await inbound(store, "m1");
    await inbound(store, "m2", { wakeEligible: false });

    assert.deepEqual((await store.listOpenWakes()).map((r) => r.msgId), ["m1"]);
    assert.equal((await store.wakeStateFor("m1")).status, "pending");
    assert.equal((await store.wakeStateFor("m2")).status, "muted");
    assert.equal(await store.wakeStateFor("outbound-only"), undefined);
  } finally {
    cleanup();
  }
});

test("claimWake is exclusive: a second claim on an in-flight delivery is refused", async () => {
  const { store, cleanup } = withStore();
  try {
    await inbound(store, "m1");
    const first = await store.claimWake("m1", { now: "2026-09-12T12:00:01.000Z" });
    const second = await store.claimWake("m1", { now: "2026-09-12T12:00:02.000Z" });

    assert.deepEqual({ claimed: first.claimed, attempts: first.attempts }, { claimed: true, attempts: 1 });
    assert.equal(second.claimed, false);
    assert.equal((await store.wakeStateFor("m1")).status, "inflight");
    assert.deepEqual(await store.listOpenWakes(), [], "in-flight rows are not offered again");
  } finally {
    cleanup();
  }
});

test("wake cursor advances only to the highest contiguous settled delivery", async () => {
  const { store, cleanup } = withStore();
  try {
    await inbound(store, "m1");
    await inbound(store, "m2");
    await inbound(store, "m3");
    assert.equal(await store.wakeCursor(), 0);

    await store.claimWake("m1");
    await store.settleWake("m1", { status: "handled" });
    assert.equal(await store.wakeCursor(), 1);

    await store.claimWake("m3");
    await store.settleWake("m3", { status: "handled" });
    assert.equal(await store.wakeCursor(), 1, "m2 is still open — the cursor must not jump the gap");

    await store.claimWake("m2");
    await store.settleWake("m2", { status: "failed", error: "boom", nextAttemptAt: "2026-09-12T13:00:00.000Z" });
    assert.equal(await store.wakeCursor(), 1, "a failed delivery is still open");

    await store.claimWake("m2", { now: "2026-09-12T13:00:01.000Z" });
    await store.settleWake("m2", { status: "handled" });
    assert.equal(await store.wakeCursor(), 3);
  } finally {
    cleanup();
  }
});

test("a failed wake is retried only once its next_attempt_at has passed, keeping attempts and error", async () => {
  const { store, cleanup } = withStore();
  try {
    await inbound(store, "m1");
    await store.claimWake("m1", { now: "2026-09-12T12:00:00.000Z" });
    await store.settleWake("m1", { status: "failed", error: "codex-timeout", nextAttemptAt: "2026-09-12T12:01:00.000Z" });

    assert.deepEqual(await store.listOpenWakes({ now: "2026-09-12T12:00:30.000Z" }), []);
    const due = await store.listOpenWakes({ now: "2026-09-12T12:01:00.000Z" });
    assert.deepEqual(due.map((r) => r.msgId), ["m1"]);

    const state = await store.wakeStateFor("m1");
    assert.equal(state.status, "failed");
    assert.equal(state.attempts, 1);
    assert.equal(state.error, "codex-timeout");

    const again = await store.claimWake("m1", { now: "2026-09-12T12:01:00.000Z" });
    assert.deepEqual({ claimed: again.claimed, attempts: again.attempts }, { claimed: true, attempts: 2 });
  } finally {
    cleanup();
  }
});

test("recoverInflightWakes returns rows abandoned by a crashed process to the retry queue", async () => {
  const { store, cleanup } = withStore();
  try {
    await inbound(store, "m1");
    await store.claimWake("m1");
    assert.deepEqual(await store.listOpenWakes(), []);

    const recovered = await store.recoverInflightWakes();

    assert.equal(recovered, 1);
    assert.equal((await store.wakeStateFor("m1")).status, "failed");
    assert.deepEqual((await store.listOpenWakes()).map((r) => r.msgId), ["m1"]);
  } finally {
    cleanup();
  }
});

test("dlq and muted are terminal: the cursor passes them and they are not offered again", async () => {
  const { store, cleanup } = withStore();
  try {
    await inbound(store, "m1");
    await inbound(store, "m2", { wakeEligible: false });
    await store.claimWake("m1");
    await store.settleWake("m1", { status: "dlq", error: "max-attempts" });

    assert.deepEqual(await store.listOpenWakes(), []);
    assert.equal(await store.wakeCursor(), 2);
    assert.equal((await store.wakeStateFor("m1")).status, "dlq");
  } finally {
    cleanup();
  }
});

test("settleWake records the relayed reply id so a retry can see the reply already exists", async () => {
  const { store, cleanup } = withStore();
  try {
    await inbound(store, "m1");
    await store.claimWake("m1");
    await store.settleWake("m1", { status: "handled", replyMsgId: "reply-1" });

    assert.equal((await store.wakeStateFor("m1")).replyMsgId, "reply-1");
  } finally {
    cleanup();
  }
});

// #108 — the Codex thread for a (peer, conversation) pair must survive a daemon restart.

test("wake threads are persisted per peer and conversation", async () => {
  const { store, cleanup } = withStore();
  try {
    assert.equal(await store.getWakeThread("agent-a", "conv-1"), undefined);

    await store.setWakeThread({ peerId: "agent-a", conversationId: "conv-1", threadId: "t-1", threadPath: "/tmp/t-1.jsonl" });
    await store.setWakeThread({ peerId: "agent-a", conversationId: "conv-2", threadId: "t-2" });

    assert.deepEqual(await store.getWakeThread("agent-a", "conv-1"), { peerId: "agent-a", conversationId: "conv-1", threadId: "t-1", threadPath: "/tmp/t-1.jsonl" });
    assert.equal((await store.getWakeThread("agent-a", "conv-2")).threadId, "t-2");
    assert.equal(await store.getWakeThread("agent-b", "conv-1"), undefined);

    await store.setWakeThread({ peerId: "agent-a", conversationId: "conv-1", threadId: "t-1b" });
    assert.equal((await store.getWakeThread("agent-a", "conv-1")).threadId, "t-1b");
  } finally {
    cleanup();
  }
});
