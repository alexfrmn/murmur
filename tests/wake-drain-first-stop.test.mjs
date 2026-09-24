// The installed Claude Code hook is a Stop hook only (no SessionStart --session). Its very
// first run in a new session has no cursor: it must seed the baseline AND keep polling, or the
// first idle wait of every session is deaf (letter 048, reproduced on the server).
// The baseline is the contour's anchor, not the tip: a letter that landed before the first Stop
// must still wake the session (24.09 acceptance, finding 5).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const script = path.resolve("scripts/wake-drain-claude.mjs");

async function waitOr(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-first- пробел Мой-"));
  const dbPath = path.join(dir, "murmur.db");
  const db = new DatabaseSync(dbPath);
  // The hook reads this store while the test inserts. Its read holds a shared lock, and a
  // writer without a busy timeout fails at once with "database is locked" (any OS in rollback
  // journal mode; Windows widens the window enough to hit it in CI).
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("CREATE TABLE local_messages (msg_id TEXT PRIMARY KEY, created_at TEXT, sender TEXT, conversation_id TEXT, direction TEXT, text TEXT)");
  const insert = (msgId, sender = "agent-peer") => db.prepare(
    "INSERT INTO local_messages VALUES (?, '2026-09-24T00:00:00.000Z', ?, 'c-1', 'inbound', 'hello')",
  ).run(msgId, sender);
  return { dir, dbPath, db, insert };
}

function poll(s, args = []) {
  const child = spawn(process.execPath, ["--no-warnings", script, "--db", s.dbPath, "--max-seconds", "20", ...args], {
    env: {
      ...process.env,
      MURMUR_DB: "",
      MURMUR_WAKE_POLL_MS: "100",
      MURMUR_WAKE_CURSOR: path.join(s.dir, "cursor"),
      MURMUR_WAKE_LOCK: path.join(s.dir, "lock"),
      MURMUR_WAKE_ANCHOR: path.join(s.dir, "anchor"),
    },
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const result = { child, closed: false };
  result.exited = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", code => { result.closed = true; done({ code, stderr }); });
  });
  return result;
}

test("the first Stop of a new session seeds the cursor and keeps polling", async t => {
  const s = store();
  let run;
  t.after(async () => {
    if (run) {
      if (!run.closed) run.child.kill();
      await run.exited;
    }
    s.db.close();
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  s.insert("history-1", "agent-old");
  fs.writeFileSync(path.join(s.dir, "anchor"), "1\n"); // an earlier session already reported it
  run = poll(s);
  // Seeded at the anchor without replaying what was reported, and still running.
  for (let i = 0; i < 50 && !fs.existsSync(path.join(s.dir, "cursor")); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readFileSync(path.join(s.dir, "cursor"), "utf8").trim(), "1");
  const early = await waitOr(run.exited, 600, null);
  assert.equal(early, null, `the first run must not exit after seeding: ${JSON.stringify(early)}`);

  s.insert("new-1", "agent-mac-fresh");
  const result = await waitOr(run.exited, 10000, { timeout: true });
  assert.equal(result.code, 2, `the first idle wait must wake: ${JSON.stringify(result)}`);
  assert.match(result.stderr, /Murmur wake: 1 new inbound message\(s\):\n {2}rowid=2 \[agent-mac-fresh\]/);
  assert.doesNotMatch(result.stderr, /agent-old/, "history before the session is not replayed");
});

test("a colleague's first letter that landed before the first Stop wakes it at once", async t => {
  const s = store();
  let run;
  t.after(async () => {
    if (run) {
      if (!run.closed) run.child.kill();
      await run.exited;
    }
    s.db.close();
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // New Identity, never drained: no anchor, no cursor, one letter already in the store.
  s.insert("first-letter", "agent-colleague");
  run = poll(s);
  const result = await waitOr(run.exited, 10000, { timeout: true });
  assert.equal(result.code, 2, `the first letter must wake the first Stop: ${JSON.stringify(result)}`);
  assert.match(result.stderr, /Murmur wake: 1 new inbound message\(s\):\n {2}rowid=1 \[agent-colleague\]/);
  assert.equal(fs.readFileSync(path.join(s.dir, "cursor"), "utf8").trim(), "1");
});

test("--once on the first run with the anchor at the tip only seeds and exits 0", async t => {
  const s = store();
  t.after(() => { s.db.close(); fs.rmSync(s.dir, { recursive: true, force: true }); });
  s.insert("history-1");
  fs.writeFileSync(path.join(s.dir, "anchor"), "1\n");
  const result = await poll(s, ["--once"]).exited;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(path.join(s.dir, "cursor"), "utf8").trim(), "1");
});
