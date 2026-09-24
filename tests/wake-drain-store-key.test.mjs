// Cursor, lock and anchor belong to one store (letter 048). Two profiles on one machine, or a
// test next to a live profile, used to share ~/.murmur-wake-anchor: the store with larger rowids
// moved the other's anchor forward and its cold start skipped real messages.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-store-key- Мой-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const stores = [];
  const children = [];
  t.after(async () => {
    for (const result of children) {
      if (!result.closed) result.child.kill();
      await result.exited;
    }
    for (const s of stores) s.db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const store = (name, rows) => {
    const dbPath = path.join(root, name, "murmur.db");
    fs.mkdirSync(path.dirname(dbPath));
    const db = new DatabaseSync(dbPath);
    // b.insert() below runs while a hook polls store b; wait for its shared read lock.
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("CREATE TABLE local_messages (msg_id TEXT PRIMARY KEY, created_at TEXT, sender TEXT, conversation_id TEXT, direction TEXT, text TEXT)");
    const insert = (msgId, sender = "agent-peer") => db.prepare(
      "INSERT INTO local_messages VALUES (?, '2026-09-24T00:00:00.000Z', ?, 'c-1', 'inbound', ?)",
    ).run(msgId, sender, `text of ${msgId}`);
    for (let i = 1; i <= rows; i++) insert(`${name}-${i}`);
    const s = { dbPath, db, insert };
    stores.push(s);
    return s;
  };
  const env = (session) => ({
    ...process.env,
    HOME: home, USERPROFILE: home, MURMUR_DB: "",
    MURMUR_WAKE_CURSOR: "", MURMUR_WAKE_LOCK: "", MURMUR_WAKE_ANCHOR: "",
    MURMUR_WAKE_SESSION_KEY: session, MURMUR_WAKE_POLL_MS: "100",
    MURMUR_WAKE_SKIPPED_LOG: path.join(root, "skipped.jsonl"),
  });
  const run = (s, session, args) => spawnSync(process.execPath, ["--no-warnings", script, "--db", s.dbPath, ...args], { env: env(session), encoding: "utf8" });
  const key = (s) => createHash("sha256").update(process.platform === "win32" ? s.dbPath.toLowerCase() : s.dbPath).digest("hex").slice(0, 8);
  return { home, store, run, env, key, children };
}

test("two stores in one home keep separate anchors, cursors and cold starts", t => {
  const h = setup(t);
  const big = h.store("big", 5);
  const small = h.store("small", 1);
  assert.equal(h.run(big, "sessionA", ["--session"]).status, 0);
  assert.equal(h.run(small, "sessionB", ["--session"]).status, 0);
  assert.equal(fs.readFileSync(path.join(h.home, `.murmur-wake-anchor-${h.key(big)}`), "utf8").trim(), "5");
  assert.equal(fs.readFileSync(path.join(h.home, `.murmur-wake-anchor-${h.key(small)}`), "utf8").trim(), "1");
  assert.ok(fs.existsSync(path.join(h.home, `.murmur-wake-cursor-${h.key(small)}-sessionB`)));
  assert.equal(fs.existsSync(path.join(h.home, ".murmur-wake-anchor")), false, "the unkeyed name is no longer written");

  // While nothing listened, rows 2..3 reached the small store. Under a shared anchor of 5 its
  // cold start saw nothing.
  small.insert("small-2", "agent-mac-fresh");
  small.insert("small-3", "agent-mac-fresh");
  const cold = h.run(small, "sessionC", ["--session"]);
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /2 inbound message\(s\) arrived while no session was alive/);
  assert.match(cold.stdout, /text of small-2/);
});

test("a legacy anchor above this store's tip is ignored, not adopted", t => {
  const h = setup(t);
  const s = h.store("profile", 1);
  fs.writeFileSync(path.join(h.home, ".murmur-wake-anchor"), "9\n"); // written for another store
  const first = h.run(s, "s1", ["--session"]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /text of profile-1/, "no anchor of ours yet: a never-drained store shows its first letter");
  s.insert("profile-2", "agent-mac-fresh");
  const cold = h.run(s, "s2", ["--session"]);
  assert.match(cold.stdout, /text of profile-2/, "a message between our tip and the foreign anchor must not be lost");
  assert.equal(fs.readFileSync(path.join(h.home, ".murmur-wake-anchor"), "utf8").trim(), "9", "the legacy file is only read");
});

test("a legacy anchor and a legacy session cursor at or below the tip carry over", t => {
  const h = setup(t);
  const s = h.store("profile", 3);
  fs.writeFileSync(path.join(h.home, ".murmur-wake-anchor"), "1\n");
  const cold = h.run(s, "s1", ["--session"]);
  assert.match(cold.stdout, /2 inbound message\(s\) arrived/, "rows 2..3 arrived after the old build's anchor");

  const h2 = setup(t);
  const s2 = h2.store("profile", 2);
  fs.writeFileSync(path.join(h2.home, ".murmur-wake-cursor-sessionA"), "1\n");
  const once = h2.run(s2, "sessionA", ["--once"]);
  assert.equal(once.status, 2, "the upgraded Stop hook continues from the old cursor instead of re-seeding past row 2");
  assert.match(once.stderr, /rowid=2 \[agent-peer\]/);
});

test("a poller on one store does not hold the lock of another store", async t => {
  const h = setup(t);
  const a = h.store("a", 1);
  const b = h.store("b", 1);
  // The first run on a never-drained store reports its row and seeds the cursor past it.
  for (const s of [a, b]) assert.equal(h.run(s, "same", ["--once"]).status, 2);
  const start = (s) => {
    const child = spawn(process.execPath, ["--no-warnings", script, "--db", s.dbPath, "--max-seconds", "20"], { env: h.env("same") });
    let stderr = "";
    child.stderr.on("data", c => { stderr += c; });
    const result = { child, closed: false };
    result.exited = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", code => { result.closed = true; done({ code, stderr }); });
    });
    h.children.push(result);
    return result;
  };
  const pollA = start(a);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(h.home, `.murmur-wake-lock-${h.key(a)}-same`)); i++) await new Promise(r => setTimeout(r, 100));
  const pollB = start(b);
  await new Promise(r => setTimeout(r, 600));
  b.insert("b-2", "agent-mac-fresh");
  const result = await waitOr(pollB.exited, 10000, { timeout: true });
  assert.equal(result.code, 2, `store b must wake while a's poller runs: ${JSON.stringify(result)}`);
  const stillA = await waitOr(pollA.exited, 300, null);
  assert.equal(stillA, null, "store a's poller keeps running");
});
