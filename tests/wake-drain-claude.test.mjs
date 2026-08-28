import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const script = path.resolve("scripts/wake-drain-claude.sh");

function withDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-drain-"));
  const dbPath = path.join(dir, "murmur.db");
  const cursorPath = path.join(dir, "cursor");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE local_messages (
      msg_id TEXT PRIMARY KEY,
      created_at TEXT,
      sender TEXT,
      conversation_id TEXT,
      direction TEXT,
      text TEXT
    );
  `);
  return { db, dbPath, cursorPath, dir };
}

function insertMessage(db, { msgId, direction = "inbound", sender = "agent-jarvis", text = "hello" }) {
  db.prepare(`
    INSERT INTO local_messages (msg_id, created_at, sender, conversation_id, direction, text)
    VALUES (?, '2026-06-20T00:00:00.000Z', ?, 'codex:task:test', ?, ?)
  `).run(msgId, sender, direction, text);
}

function drain({ dbPath, cursorPath }, extraEnv = {}) {
  return spawnSync(script, [], {
    env: {
      ...process.env,
      MURMUR_DB: dbPath,
      MURMUR_WAKE_CURSOR: cursorPath,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

// A session that has never drained has no cursor file. Seeding it to the current
// tip is what makes the per-session cursor usable at all: without it the first
// drain of every new session would replay the whole inbound history as "new".
test("Claude wake drain seeds the cursor to the tip on first run and stays silent", () => {
  const ctx = withDb();
  insertMessage(ctx.db, { msgId: "inbound-old-1", text: "history one" });
  insertMessage(ctx.db, { msgId: "inbound-old-2", text: "history two" });

  const result = drain(ctx);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "2");
});

test("Claude wake drain exits 0 when there are no new inbound messages", () => {
  const ctx = withDb();
  insertMessage(ctx.db, { msgId: "outbound-1", direction: "outbound", text: "ignore me" });

  const seed = drain(ctx);
  assert.equal(seed.status, 0);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "0");

  const result = drain(ctx);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("Claude wake drain emits new inbound rows and advances the cursor", () => {
  const ctx = withDb();
  drain(ctx); // seed at an empty tip

  insertMessage(ctx.db, { msgId: "inbound-1", text: "first\nline" });
  insertMessage(ctx.db, { msgId: "outbound-1", direction: "outbound", text: "ignore me" });
  insertMessage(ctx.db, { msgId: "inbound-2", sender: "agent-peer", text: "second" });

  const result = drain(ctx);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Murmur wake: 2 new inbound message\(s\):/);
  assert.match(result.stderr, /rowid=1 \[agent-jarvis\] first line/);
  assert.match(result.stderr, /rowid=3 \[agent-peer\] second/);
  assert.doesNotMatch(result.stderr, /ignore me/);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "3");
});

test("Claude wake drain cursor dedup prevents repeat wakes", () => {
  const ctx = withDb();
  drain(ctx); // seed

  insertMessage(ctx.db, { msgId: "inbound-1", text: "first" });

  const first = drain(ctx);
  const second = drain(ctx);

  assert.equal(first.status, 2);
  assert.equal(second.status, 0);
  assert.equal(second.stderr, "");
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "1");
});

// The point of the per-session cursor: one inbound message must wake EVERY live
// session, not just whichever one reached the hook first. With a shared cursor
// the second session below would see nothing.
test("Claude wake drain keeps a separate cursor per session key", () => {
  const ctx = withDb();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-home-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-home-b-"));

  // No explicit MURMUR_WAKE_CURSOR: the script must derive it from the session key.
  const drainAs = (home, sessionKey) =>
    spawnSync(script, [], {
      env: {
        ...process.env,
        MURMUR_DB: ctx.dbPath,
        MURMUR_WAKE_CURSOR: "",
        HOME: home,
        CLAUDE_CODE_SESSION_ID: sessionKey,
      },
      encoding: "utf8",
    });

  assert.equal(drainAs(dirA, "aaaaaaaa-1111").status, 0); // seed session A
  assert.equal(drainAs(dirB, "bbbbbbbb-2222").status, 0); // seed session B

  insertMessage(ctx.db, { msgId: "inbound-1", text: "one message, two sessions" });

  const wokeA = drainAs(dirA, "aaaaaaaa-1111");
  const wokeB = drainAs(dirB, "bbbbbbbb-2222");

  assert.equal(wokeA.status, 2, "session A must wake");
  assert.equal(wokeB.status, 2, "session B must wake on the same message");
  assert.match(wokeA.stderr, /one message, two sessions/);
  assert.match(wokeB.stderr, /one message, two sessions/);

  assert.ok(fs.existsSync(path.join(dirA, ".murmur-wake-cursor-aaaaaaaa")));
  assert.ok(fs.existsSync(path.join(dirB, ".murmur-wake-cursor-bbbbbbbb")));
});
