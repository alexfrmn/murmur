// The node port of wake-drain-claude.sh (Windows / no sqlite3 CLI). Mirrors the shell
// suite, plus the cases the port itself introduced: a lock, a session key, and faults
// that must be reported instead of swallowed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const script = path.resolve("scripts/wake-drain-claude.mjs");

function withDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-node-"));
  const dbPath = path.join(dir, "murmur.db");
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
  return { db, dbPath, dir, cursorPath: path.join(dir, "cursor"), lockPath: path.join(dir, "lock") };
}

function insertMessage(db, { msgId, direction = "inbound", sender = "agent-jarvis", text = "hello" }) {
  db.prepare(`
    INSERT INTO local_messages (msg_id, created_at, sender, conversation_id, direction, text)
    VALUES (?, '2026-08-28T00:00:00.000Z', ?, 'codex:task:test', ?, ?)
  `).run(msgId, sender, direction, text);
}

function drain(ctx, extraEnv = {}) {
  return spawnSync(process.execPath, ["--no-warnings", script, "--once"], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

test("node drain seeds the cursor to the tip on first run and stays silent", () => {
  const ctx = withDb();
  insertMessage(ctx.db, { msgId: "old-1", text: "history one" });
  insertMessage(ctx.db, { msgId: "old-2", text: "history two" });

  const result = drain(ctx);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "2");
});

test("node drain emits new inbound rows and advances the cursor", () => {
  const ctx = withDb();
  drain(ctx); // seed

  insertMessage(ctx.db, { msgId: "in-1", text: "first\nline" });
  insertMessage(ctx.db, { msgId: "out-1", direction: "outbound", text: "ignore me" });
  insertMessage(ctx.db, { msgId: "in-2", sender: "agent-peer", text: "second" });

  const result = drain(ctx);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Murmur wake: 2 new inbound message\(s\):/);
  assert.match(result.stderr, /rowid=1 \[agent-jarvis\] first line/);
  assert.match(result.stderr, /rowid=3 \[agent-peer\] second/);
  assert.doesNotMatch(result.stderr, /ignore me/);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "3");
});

test("node drain dedups: the same message does not wake twice", () => {
  const ctx = withDb();
  drain(ctx);
  insertMessage(ctx.db, { msgId: "in-1", text: "first" });

  assert.equal(drain(ctx).status, 2);
  const second = drain(ctx);

  assert.equal(second.status, 0);
  assert.equal(second.stderr, "");
});

// The cursor must land on the last row that was REPORTED. Advancing it to the table's
// tip instead skips anything inserted between the SELECT and the tip query — that row
// then never wakes anyone.
test("node drain never advances the cursor past a row it did not report", () => {
  const ctx = withDb();
  drain(ctx);
  insertMessage(ctx.db, { msgId: "in-1", text: "reported" });

  const result = drain(ctx);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /reported/);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "1", "cursor = last reported rowid");
});

test("node drain keeps a separate cursor per session key", () => {
  const ctx = withDb();
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-node-home-a-"));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-node-home-b-"));

  const drainAs = (home, sessionKey) =>
    spawnSync(process.execPath, ["--no-warnings", script, "--once"], {
      env: {
        ...process.env,
        MURMUR_DB: ctx.dbPath,
        MURMUR_WAKE_CURSOR: "",
        MURMUR_WAKE_LOCK: "",
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CODE_SESSION_ID: sessionKey,
      },
      encoding: "utf8",
    });

  assert.equal(drainAs(homeA, "aaaaaaaa-1111").status, 0);
  assert.equal(drainAs(homeB, "bbbbbbbb-2222").status, 0);

  insertMessage(ctx.db, { msgId: "in-1", text: "one message, two sessions" });

  assert.equal(drainAs(homeA, "aaaaaaaa-1111").status, 2, "session A must wake");
  assert.equal(drainAs(homeB, "bbbbbbbb-2222").status, 2, "session B must wake on the same message");

  assert.ok(fs.existsSync(path.join(homeA, ".murmur-wake-cursor-aaaaaaaa")));
  assert.ok(fs.existsSync(path.join(homeB, ".murmur-wake-cursor-bbbbbbbb")));
});

// A hook that dies without a word is the failure this script was written to fix, so a
// fault reports the reason. It still exits 0: a non-zero exit would wake the session
// with a false alarm.
test("node drain reports a missing store instead of exiting silently", () => {
  const ctx = withDb();
  const result = drain(ctx, { MURMUR_DB: path.join(ctx.dir, "nope.db") });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /murmur wake: store not readable/);
  assert.match(result.stderr, /nope\.db/);
});

test("node drain reports an unreadable store instead of exiting silently", () => {
  const ctx = withDb();
  drain(ctx); // seed, so the run gets past the baseline branch
  fs.writeFileSync(ctx.dbPath, "this is not a sqlite database");

  const result = drain(ctx);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /murmur wake: drain failed/);
});
