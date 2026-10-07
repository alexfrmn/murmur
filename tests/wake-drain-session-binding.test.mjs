// AIM-5939: a reply must wake the Claude Code session that holds the conversation, not
// every open session on the profile.
//
// The MCP server records the sending session as the conversation's owner next to the
// store; the Stop-hook drain of every other session skips replies on that conversation
// while the owner is alive. The first test runs the real chain: a live MCP client sends,
// the reply lands in the store, two drains with different session keys read it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const nodeScript = path.resolve("scripts/wake-drain-claude.mjs");
const SESSION_A = "aaaaaaaa-1111-4000-8000-000000000001";
const SESSION_B = "bbbbbbbb-2222-4000-8000-000000000002";

const baseEnv = () => {
  const env = { ...process.env, MURMUR_UPDATE_CHECK: "0" };
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "MURMUR_SESSION_ID", "MURMUR_WAKE_SESSION_KEY"]) delete env[key];
  return env;
};

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "murmur-session-binding-")));
  const children = [];
  const dbs = [];
  t.after(async () => {
    for (const db of dbs) { try { db.close(); } catch {} }
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const dataDir = path.join(root, "a");
  const dbPath = path.join(dataDir, "murmur.db");
  const bindingsDir = path.join(dataDir, ".claude-session-bindings");
  const drain = (session, args = ["--once"], extra = {}) => spawnSync(process.execPath, ["--no-warnings", nodeScript, "--db", dbPath, ...args], {
    encoding: "utf8",
    env: {
      ...baseEnv(),
      HOME: root,
      USERPROFILE: root, // os.homedir() on Windows: keep cursors and anchors out of the real home
      CLAUDE_CODE_SESSION_ID: session,
      MURMUR_WAKE_SKIPPED_LOG: path.join(root, "skipped.jsonl"),
      ...extra,
    },
  });
  const ledger = () => {
    const file = path.join(root, "skipped.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  return { root, dataDir, dbPath, bindingsDir, drain, ledger, children, dbs };
}

function storeWithMessages(f) {
  fs.mkdirSync(f.dataDir, { recursive: true });
  const db = new DatabaseSync(f.dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS local_messages (
    msg_id TEXT PRIMARY KEY, created_at TEXT, sender TEXT, conversation_id TEXT,
    direction TEXT, text TEXT, wake_eligible INTEGER)`);
  f.dbs.push(db);
  return db;
}

let seq = 0;
const inbound = (db, conversationId, sender = "agent-peer") => db.prepare(
  `INSERT INTO local_messages (msg_id, created_at, sender, conversation_id, direction, text, wake_eligible)
   VALUES (?, '2026-10-07T00:00:00.000Z', ?, ?, 'inbound', 'reply', 1)`,
).run(`m${++seq}-${process.pid}`, sender, conversationId);

const writeBinding = (f, conversationId, { session = SESSION_A, pid = process.pid, updatedAt = new Date().toISOString() } = {}) => {
  fs.mkdirSync(f.bindingsDir, { recursive: true });
  const file = path.join(f.bindingsDir, `${createHash("sha256").update(conversationId).digest("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify({ conversationId, sessionId: session, pid, updatedAt }));
};

// Both drains start their cursors at the tip, so only rows inserted after this are new.
function seedCursors(f) {
  for (const session of [SESSION_A, SESSION_B]) assert.equal(f.drain(session, ["--once"], { MURMUR_WAKE_FIRST_MAX: "0" }).status, 0);
}

function mcpClient(f, session) {
  const child = spawn(process.execPath, ["packages/mcp-server/dist/src/index.js"], {
    env: {
      ...baseEnv(), HOME: f.root, DATA_DIR: f.dataDir, CLAUDE_CODE_SESSION_ID: session,
      MURMUR_STORE_PATH: f.dbPath, MURMUR_CHANNEL_ROSTER_PATH: path.join(f.dataDir, "channel-roster.db"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  f.children.push({ child, closed });
  child.stderr.resume();
  const pending = new Map();
  let counter = 0;
  createInterface({ input: child.stdout }).on("line", (line) => { const r = JSON.parse(line); pending.get(r.id)?.(r); });
  const call = async (name, args = {}) => {
    const id = ++counter;
    let timer;
    try {
      const response = await new Promise((resolve, reject) => {
        pending.set(id, resolve);
        timer = setTimeout(() => reject(new Error("MCP test timed out")), 8000);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
      assert.equal(response.error, undefined, response.error?.message);
      return JSON.parse(response.result.content[0].text);
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  return { child, closed, call };
}

test("a reply wakes only the Claude Code session that sent on the conversation", { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  const cli = (id, ...args) => JSON.parse(execFileSync(process.execPath, ["packages/setup/bin/murmur.mjs", ...args, "--data-dir", path.join(f.root, id), "--json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...baseEnv(), HOME: f.root },
  }));
  cli("a", "init", "--agent-id", "agent-a", "--broker-url", "nats://127.0.0.1:1");
  cli("a", "invite", "--broker", "nats://server.example.com:4222", "--out", path.join(f.root, "invite.txt"));
  cli("b", "join", "--agent-id", "agent-b", "--invite-file", path.join(f.root, "invite.txt"), "--reply-out", path.join(f.root, "reply.txt"));
  cli("a", "add-peer", "--reply-file", path.join(f.root, "reply.txt"));

  const a = mcpClient(f, SESSION_A);
  const sent = await a.call("murmur_send", { to: "agent-b", text: "question", conversationId: "conv-bound" });
  assert.equal(sent.status, "queued");
  const binding = JSON.parse(fs.readFileSync(
    path.join(f.bindingsDir, `${createHash("sha256").update("conv-bound").digest("hex")}.json`), "utf8"));
  assert.equal(binding.sessionId, SESSION_A);
  assert.equal(binding.conversationId, "conv-bound");
  assert.equal(binding.pid, a.child.pid);

  const db = storeWithMessages(f);
  seedCursors(f);
  inbound(db, "conv-bound");

  const other = f.drain(SESSION_B);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.stderr, "");
  assert.deepEqual(f.ledger().map((e) => e.reason), ["bound-to-other-session"]);

  const owner = f.drain(SESSION_A);
  assert.equal(owner.status, 2, owner.stderr);
  assert.match(owner.stderr, /Murmur wake: 1 new inbound message\(s\)/);

  // The owner closes: its MCP process is gone, the binding no longer holds anyone back.
  a.child.kill();
  await a.closed;
  inbound(db, "conv-bound");
  const afterClose = f.drain(SESSION_B);
  assert.equal(afterClose.status, 2, afterClose.stderr);
  assert.match(afterClose.stderr, /Murmur wake: 1 new inbound message\(s\)/);
});

test("an unbound conversation still wakes every session", (t) => {
  const f = fixture(t);
  const db = storeWithMessages(f);
  seedCursors(f);
  writeBinding(f, "conv-bound");
  inbound(db, "conv-open");
  assert.equal(f.drain(SESSION_A).status, 2);
  assert.equal(f.drain(SESSION_B).status, 2);
  assert.deepEqual(f.ledger(), []);
});

test("a stale or dead binding does not hold other sessions back", (t) => {
  const f = fixture(t);
  const db = storeWithMessages(f);
  seedCursors(f);
  writeBinding(f, "conv-old", { updatedAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString() });
  writeBinding(f, "conv-dead", { pid: 2 ** 31 - 2 });
  writeBinding(f, "conv-short", { updatedAt: new Date(Date.now() - 120 * 1000).toISOString() });
  inbound(db, "conv-old");
  inbound(db, "conv-dead");
  inbound(db, "conv-short");
  const woke = f.drain(SESSION_B, ["--once"], { MURMUR_WAKE_BIND_TTL_SECONDS: "60" });
  assert.equal(woke.status, 2, woke.stderr);
  assert.match(woke.stderr, /Murmur wake: 3 new inbound message\(s\)/);
});

test("a drain that does not know its own session never filters by binding", (t) => {
  const f = fixture(t);
  const db = storeWithMessages(f);
  assert.equal(f.drain("", ["--once"], { MURMUR_WAKE_FIRST_MAX: "0" }).status, 0);
  writeBinding(f, "conv-bound");
  inbound(db, "conv-bound");
  assert.equal(f.drain("").status, 2);
});

test("a cold start of a new session leaves a bound conversation to its owner", (t) => {
  const f = fixture(t);
  const db = storeWithMessages(f);
  seedCursors(f);
  writeBinding(f, "conv-bound");
  inbound(db, "conv-bound");
  inbound(db, "conv-open");
  const cold = f.drain("cccccccc-3333-4000-8000-000000000003", ["--session"]);
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /1 inbound message\(s\) arrived/);
  assert.match(cold.stdout, /rowid=2 /);
  assert.doesNotMatch(cold.stdout, /rowid=1 /);
});

// The letter nobody asked for (AIM-5939, 07.10): a peer writes first. A session in a project
// that opted out with MURMUR_WAKE_ONLY_BOUND=1 stays quiet; a session without the flag wakes.
test("an only-bound session skips a letter nobody asked for and wakes on its own reply", (t) => {
  const f = fixture(t);
  const db = storeWithMessages(f);
  const quiet = { MURMUR_WAKE_ONLY_BOUND: "1" };
  assert.equal(f.drain(SESSION_A, ["--once"], { MURMUR_WAKE_FIRST_MAX: "0" }).status, 0);
  assert.equal(f.drain(SESSION_B, ["--once"], { MURMUR_WAKE_FIRST_MAX: "0", ...quiet }).status, 0);

  inbound(db, "dm:agent-danik:agent-misha", "agent-danik");
  const skipped = f.drain(SESSION_B, ["--once"], quiet);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stderr, "");
  assert.deepEqual(f.ledger().map((e) => e.reason), ["not-bound-to-this-session"]);
  assert.equal(f.drain(SESSION_A).status, 2);

  writeBinding(f, "conv-b", { session: SESSION_B });
  writeBinding(f, "conv-a", { session: SESSION_A });
  inbound(db, "conv-b");
  inbound(db, "conv-a");
  const own = f.drain(SESSION_B, ["--once"], quiet);
  assert.equal(own.status, 2, own.stderr);
  assert.match(own.stderr, /Murmur wake: 1 new inbound message\(s\):\n  rowid=2 /);
  assert.deepEqual(f.ledger().slice(1).map((e) => [e.rowid, e.reason]), [[3, "bound-to-other-session"]]);
});

test("an only-bound drain that cannot name its session wakes on nothing", (t) => {
  const f = fixture(t);
  const db = storeWithMessages(f);
  assert.equal(f.drain("", ["--once"], { MURMUR_WAKE_FIRST_MAX: "0" }).status, 0);
  writeBinding(f, "conv-bound");
  inbound(db, "conv-bound");
  inbound(db, "conv-open");
  const run = f.drain("", ["--once"], { MURMUR_WAKE_ONLY_BOUND: "1" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(f.ledger().map((e) => e.reason), ["not-bound-to-this-session", "not-bound-to-this-session"]);
});
