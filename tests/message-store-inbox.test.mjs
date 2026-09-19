import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";

const withStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-inbox-"));
  const dbPath = join(dir, "murmur.db");
  const store = new SQLiteMessageStore(dbPath);
  return { store, dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const append = (store, { direction, sender, text, at }) =>
  store.append({
    conversationId: "peer:task:test",
    msgId: `${direction}-${text.slice(0, 8)}-${at}`,
    direction,
    sender,
    text,
    createdAt: at,
  });

test("listInbound returns delivered inbound messages that never mention the agent", async () => {
  const { store, cleanup } = withStore();
  try {
    // The regression from #114: none of these three spell out the receiving agent's
    // name, which is the normal case for a reply.
    await append(store, { direction: "inbound", sender: "agent-peer", text: "done, deployed", at: "2026-08-26T22:00:00.000Z" });
    await append(store, { direction: "inbound", sender: "agent-peer", text: "logs look clean", at: "2026-08-26T22:01:00.000Z" });
    await append(store, { direction: "outbound", sender: "agent-claude", text: "check the logs", at: "2026-08-26T22:02:00.000Z" });

    const inbound = await store.listInbound(20);

    assert.equal(inbound.length, 2);
    assert.ok(inbound.every((m) => m.direction === "inbound"));
    assert.deepEqual(inbound.map((m) => m.text), ["logs look clean", "done, deployed"]);
  } finally {
    cleanup();
  }
});

test("the old searchMessages(agentId) form is what dropped them", async () => {
  const { store, cleanup } = withStore();
  try {
    await append(store, { direction: "inbound", sender: "agent-peer", text: "done, deployed", at: "2026-08-26T22:00:00.000Z" });

    // Guards the reason for the fix rather than the fix itself: a LIKE over
    // text/sender/conversationId cannot see a message that does not name the agent,
    // and the tool reported count:0 while the sender saw the message acked.
    const viaSearch = await store.searchMessages("agent-claude", 100);
    assert.equal(viaSearch.length, 0);

    const viaInbox = await store.listInbound(20);
    assert.equal(viaInbox.length, 1);
  } finally {
    cleanup();
  }
});

test("listInbound honours the limit and returns newest first", async () => {
  const { store, cleanup } = withStore();
  try {
    for (let i = 0; i < 5; i += 1) {
      await append(store, {
        direction: "inbound",
        sender: "agent-peer",
        text: `msg ${i}`,
        at: `2026-08-26T22:0${i}:00.000Z`,
      });
    }

    const inbound = await store.listInbound(2);

    assert.equal(inbound.length, 2);
    assert.deepEqual(inbound.map((m) => m.text), ["msg 4", "msg 3"]);
  } finally {
    cleanup();
  }
});

test("message store persists Phase N routing metadata for inbox and request correlation", async () => {
  const { store, cleanup } = withStore();
  try {
    await store.append({
      conversationId: "codex:task:routed",
      msgId: "routed-1",
      direction: "inbound",
      sender: "agent-server",
      text: "routed reply",
      createdAt: "2026-08-26T22:05:00.000Z",
      transport: "nats",
      channelId: "channel-1",
      senderMemberId: "topic:5935",
      addresseeMemberId: "mac",
    });

    const [row] = await store.getInboundAfter(
      "codex:task:routed",
      "2026-08-26T22:04:00.000Z",
      10,
    );
    assert.equal(row.channelId, "channel-1");
    assert.equal(row.senderMemberId, "topic:5935");
    assert.equal(row.addresseeMemberId, "mac");
  } finally {
    cleanup();
  }
});

test("message store persists receive-time wake eligibility without changing legacy NULL rows", async () => {
  const { store, dbPath, cleanup } = withStore();
  try {
    await store.append({
      conversationId: "codex:task:muted",
      msgId: "muted-1",
      direction: "inbound",
      sender: "agent-server",
      text: "observer copy",
      createdAt: "2026-08-26T22:06:00.000Z",
      wakeEligible: false,
    });
    await store.append({
      conversationId: "legacy:conversation",
      msgId: "legacy-1",
      direction: "inbound",
      sender: "agent-server",
      text: "legacy copy",
      createdAt: "2026-08-26T22:07:00.000Z",
    });

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare(
      "SELECT msg_id as msgId, wake_eligible as wakeEligible FROM local_messages ORDER BY rowid",
    ).all().map((row) => ({ ...row }));
    db.close();
    assert.deepEqual(rows, [
      { msgId: "muted-1", wakeEligible: 0 },
      { msgId: "legacy-1", wakeEligible: null },
    ]);
  } finally {
    cleanup();
  }
});

test("message store migrates legacy databases with wake eligibility defaulting to NULL", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-inbox-migration-"));
  const dbPath = join(dir, "murmur.db");
  try {
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
        transport TEXT,
        channel_id TEXT,
        sender_member_id TEXT,
        addressee_member_id TEXT
      );
      INSERT INTO local_messages
        (id, conversation_id, msg_id, direction, sender, text, created_at)
      VALUES
        ('legacy-id', 'legacy:conversation', 'legacy-msg', 'inbound', 'agent-server', 'old row', '2026-08-26T22:00:00.000Z');
    `);
    legacy.close();

    new SQLiteMessageStore(dbPath);

    const migrated = new DatabaseSync(dbPath);
    const columns = migrated.prepare("PRAGMA table_info(local_messages)").all();
    const row = migrated.prepare(
      "SELECT wake_eligible as wakeEligible FROM local_messages WHERE msg_id = 'legacy-msg'",
    ).get();
    migrated.close();
    assert.ok(columns.some((column) => column.name === "wake_eligible"));
    assert.equal(row.wakeEligible, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
