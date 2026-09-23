// The drain cursor must never step over a row nobody looked at.
//
// The shell drain used to select the rows to report, then ask the table for its tip and
// write THAT as the cursor. Anything between the two queries — a row that landed in the
// gap, or a row a local filter had just removed from the report — ended up below the new
// cursor, where no future drain would ever select it again.
//
// Both drains are exercised here: scripts/wake-drain-claude.sh and its node port. They are
// two implementations of one contract, so the contract is tested once against both.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { skipPosixShell } from "./windows-host.mjs";

const shellScript = path.resolve("scripts/wake-drain-claude.sh");
const nodeScript = path.resolve("scripts/wake-drain-claude.mjs");

function withDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-filter-"));
  const dbPath = path.join(dir, "murmur.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE local_messages (
      msg_id TEXT PRIMARY KEY,
      created_at TEXT,
      sender TEXT,
      conversation_id TEXT,
      direction TEXT,
      text TEXT,
      wake_eligible INTEGER
    );
  `);
  return {
    db, dbPath, dir,
    cursorPath: path.join(dir, "cursor"),
    lockPath: path.join(dir, "lock"),
    anchorPath: path.join(dir, "anchor"),
    skippedPath: path.join(dir, "skipped.jsonl"),
  };
}

function insert(db, { msgId, sender = "agent-peer", conversationId = "conv-open", direction = "inbound", wakeEligible = 1 }) {
  db.prepare(`
    INSERT INTO local_messages (msg_id, created_at, sender, conversation_id, direction, text, wake_eligible)
    VALUES (?, '2026-09-15T00:00:00.000Z', ?, ?, ?, ?, ?)
  `).run(msgId, sender, conversationId, direction, `text of ${msgId}`, wakeEligible);
}

const envFor = (ctx, extra) => ({
  ...process.env,
  HOME: ctx.dir, // never let a test reach the real cursor/anchor/ledger in $HOME
  MURMUR_DB: ctx.dbPath,
  MURMUR_WAKE_CURSOR: ctx.cursorPath,
  MURMUR_WAKE_LOCK: ctx.lockPath,
  MURMUR_WAKE_ANCHOR: ctx.anchorPath,
  MURMUR_WAKE_SKIPPED_LOG: ctx.skippedPath,
  ...extra,
});

const runners = [
  {
    name: "shell drain",
    skip: skipPosixShell,
    run: (ctx, extra = {}) => spawnSync(shellScript, [], { env: envFor(ctx, extra), encoding: "utf8" }),
  },
  {
    name: "node drain",
    run: (ctx, extra = {}) =>
      spawnSync(process.execPath, ["--no-warnings", nodeScript, "--once"], { env: envFor(ctx, extra), encoding: "utf8" }),
  },
];

const cursorOf = (ctx) => Number(fs.readFileSync(ctx.cursorPath, "utf8").trim());
const ledgerOf = (ctx) => {
  if (!fs.existsSync(ctx.skippedPath)) return [];
  const raw = fs.readFileSync(ctx.skippedPath, "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
};

// Five inbound messages, two of them under a local filter.
function seedFive(ctx) {
  insert(ctx.db, { msgId: "m1" });                                     // 1 → reported
  insert(ctx.db, { msgId: "m2", sender: "agent-muted" });              // 2 → skipped: sender
  insert(ctx.db, { msgId: "m3" });                                     // 3 → reported
  insert(ctx.db, { msgId: "m4", conversationId: "conv-owned" });       // 4 → skipped: conversation
  insert(ctx.db, { msgId: "m5" });                                     // 5 → reported
}

const FILTER = {
  MURMUR_WAKE_SKIP_SENDERS: "agent-muted",
  MURMUR_WAKE_SKIP_CONVERSATIONS: "conv-owned",
};

for (const { name, run, skip } of runners) {
  test(`${name}: muted doctor rows are ledgered without waking while ordinary and legacy rows remain visible`, { skip }, t => {
    const ctx = withDb();
    t.after(() => { ctx.db.close(); fs.rmSync(ctx.dir, {recursive:true,force:true}); });
    assert.equal(run(ctx).status, 0);
    insert(ctx.db, {msgId:'protocol',conversationId:'murmur:doctor:new',wakeEligible:0});
    insert(ctx.db, {msgId:'ordinary-muted',wakeEligible:0});
    insert(ctx.db, {msgId:'legacy',conversationId:'murmur:doctor:legacy',wakeEligible:null});
    const first = run(ctx);
    assert.equal(first.status, 2);
    assert.match(first.stderr, /Murmur wake: 2 new inbound message\(s\):/);
    assert.doesNotMatch(first.stderr, /rowid=1 /);
    assert.deepEqual(ledgerOf(ctx).map(e=>[e.rowid,e.reason]), [[1,'doctor-protocol']]);
    assert.equal(cursorOf(ctx), 3);
    insert(ctx.db, {msgId:'protocol-only',conversationId:'murmur:doctor:next',wakeEligible:0});
    const second = run(ctx);
    assert.equal(second.status, 0); assert.equal(second.stderr, '');
    assert.equal(cursorOf(ctx), 4); assert.equal(ledgerOf(ctx).length, 2);
  });

  test(`${name}: filtered rows are recorded in state, reported rows do not repeat`, { skip }, () => {
    const ctx = withDb();
    assert.equal(run(ctx).status, 0, "first run seeds the cursor at an empty tip");

    seedFive(ctx);

    const first = run(ctx, FILTER);
    assert.equal(first.status, 2, "three unfiltered messages must wake the session");
    assert.match(first.stderr, /Murmur wake: 3 new inbound message\(s\):/);
    assert.match(first.stderr, /rowid=1 \[agent-peer\]/);
    assert.match(first.stderr, /rowid=3 \[agent-peer\]/);
    assert.match(first.stderr, /rowid=5 \[agent-peer\]/);
    assert.doesNotMatch(first.stderr, /rowid=2 /, "a filtered row must not be reported");
    assert.doesNotMatch(first.stderr, /rowid=4 /, "a filtered row must not be reported");

    // The filtered rows are not gone: they are in the ledger, with the reason they were
    // passed over. This is the whole difference between "skipped" and "lost".
    const ledger = ledgerOf(ctx);
    assert.deepEqual(ledger.map((entry) => entry.rowid), [2, 4]);
    assert.deepEqual(ledger.map((entry) => entry.reason), ["sender-filtered", "conversation-filtered"]);
    assert.equal(ledger[0].sender, "agent-muted");
    assert.equal(ledger[1].conversationId, "conv-owned");

    // The invariant: every row the cursor now stands past was either reported or recorded.
    assert.equal(cursorOf(ctx), 5);
    const accounted = new Set([...ledger.map((entry) => entry.rowid)]);
    for (const rowid of [1, 3, 5]) accounted.add(rowid);
    for (let rowid = 1; rowid <= cursorOf(ctx); rowid += 1) {
      assert.ok(accounted.has(rowid), `rowid ${rowid} is below the cursor and accounted for nowhere`);
    }

    // Second pass over the same store: nothing repeats and nothing is recorded twice.
    const second = run(ctx, FILTER);
    assert.equal(second.status, 0, "handled messages must not wake the session again");
    assert.equal(second.stderr, "");
    assert.equal(cursorOf(ctx), 5);
    assert.equal(ledgerOf(ctx).length, 2, "a second pass must not re-record the same skipped rows");
  });

  test(`${name}: an all-filtered batch advances the cursor, records every row and wakes nobody`, { skip }, () => {
    const ctx = withDb();
    assert.equal(run(ctx).status, 0);

    insert(ctx.db, { msgId: "m1", sender: "agent-muted" });
    insert(ctx.db, { msgId: "m2", sender: "agent-muted" });

    const result = run(ctx, FILTER);
    assert.equal(result.status, 0, "nothing to report means no wake");
    assert.equal(result.stderr, "");
    assert.deepEqual(ledgerOf(ctx).map((entry) => entry.rowid), [1, 2]);
    assert.equal(cursorOf(ctx), 2, "the cursor still moves — the rows are accounted for");
  });

  test(`${name}: with no filter set every inbound row is reported and no ledger is written`, { skip }, () => {
    const ctx = withDb();
    assert.equal(run(ctx).status, 0);

    seedFive(ctx);

    const result = run(ctx);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Murmur wake: 5 new inbound message\(s\):/);
    assert.equal(cursorOf(ctx), 5);
    assert.equal(fs.existsSync(ctx.skippedPath), false, "an unset filter must skip nothing at all");
  });

  test(`${name}: wake_eligible=0 is passed over only when the drain is asked to`, { skip }, () => {
    const ctx = withDb();
    assert.equal(run(ctx).status, 0);

    insert(ctx.db, { msgId: "m1" });
    insert(ctx.db, { msgId: "m2", wakeEligible: 0 });

    // Default: the daemon's mute flag does not change what the drain reports.
    const reported = run(ctx);
    assert.equal(reported.status, 2);
    assert.match(reported.stderr, /Murmur wake: 2 new inbound message\(s\):/);

    // Opt in: the muted row is passed over, and recorded rather than dropped.
    fs.writeFileSync(ctx.cursorPath, "0\n");
    const filtered = run(ctx, { MURMUR_WAKE_SKIP_INELIGIBLE: "1" });
    assert.equal(filtered.status, 2);
    assert.match(filtered.stderr, /Murmur wake: 1 new inbound message\(s\):/);
    assert.deepEqual(ledgerOf(ctx).map((entry) => [entry.rowid, entry.reason]), [[2, "wake-ineligible"]]);
    assert.equal(cursorOf(ctx), 2);
  });
}

// A store from before the wake_eligible column exists must still drain: the drain asks the
// schema, not the rows, and falls back to "everything is eligible".
test("both drains work against a store without the wake_eligible column", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-legacy-"));
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
  db.prepare(`
    INSERT INTO local_messages (msg_id, created_at, sender, conversation_id, direction, text)
    VALUES ('m1', '2026-09-15T00:00:00.000Z', 'agent-peer', 'conv-open', 'inbound', 'hello')
  `).run();

  for (const { name, run, skip } of runners) {
    if (skip) { t.diagnostic(`${name} not run: ${skip}`); continue; }
    const ctx = {
      dir, dbPath,
      cursorPath: path.join(dir, `cursor-${name.replace(/\s+/g, "-")}`),
      lockPath: path.join(dir, `lock-${name.replace(/\s+/g, "-")}`),
      anchorPath: path.join(dir, `anchor-${name.replace(/\s+/g, "-")}`),
      skippedPath: path.join(dir, `skipped-${name.replace(/\s+/g, "-")}.jsonl`),
    };
    fs.writeFileSync(ctx.cursorPath, "0\n");
    const result = run(ctx, { MURMUR_WAKE_SKIP_INELIGIBLE: "1" });
    assert.equal(result.status, 2, `${name} must still report on a pre-wake_eligible store`);
    assert.match(result.stderr, /Murmur wake: 1 new inbound message\(s\):/);
  }
});
