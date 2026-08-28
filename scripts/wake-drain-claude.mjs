#!/usr/bin/env node
// wake-drain-claude.mjs — native, dependency-free wake for Claude Code agents.
//
// A node port of wake-drain-claude.sh. It reads the daemon's SQLite store with
// the built-in `node:sqlite` module instead of shelling out to the `sqlite3`
// CLI binary. `sqlite3` is not present on a default Windows install (the daemon
// itself uses `node:sqlite`, not the CLI), so the shell version's query returns
// empty, the hook exits 0, and the session is never woken — native wake looks
// broken on Windows when the real cause is just a missing binary.
//
// Registered as a Claude Code hook (Stop) with `asyncRewake: true`: it runs in
// the background and, when a NEW inbound Murmur message appears, prints it to
// stderr and exits 2 — Claude Code then wraps the output in a <system-reminder>
// and wakes the idle session.
//
// Two modes:
//   (default)  poll — watch the store for up to MURMUR_WAKE_MAX_SECONDS and
//              exit 2 the moment a new inbound row appears, else exit 0 at the
//              deadline. A one-shot Stop hook cannot catch a message that lands
//              while the session is already idle; polling closes that gap.
//   --once     single check, no polling (cheap; e.g. a PostToolUse hook).
//
// Dedup is cursor-based (last drained inbound rowid), so a message wakes exactly
// once. In poll mode a lock file keeps at most one poller alive at a time.
//
// Run under `node --no-warnings` to suppress the node:sqlite ExperimentalWarning
// so it does not leak into the wake system-reminder.
//
// A fault never exits non-zero (that would wake the session with a false alarm) and never
// exits silently either — the reason goes to stderr and the exit code stays 0.
//
// Env (all optional; same contract as wake-drain-claude.sh plus lock/poll knobs):
//   MURMUR_DB               daemon SQLite store path (default: .data/murmur.db)
//   MURMUR_WAKE_SESSION_KEY overrides the key used to build the default cursor/lock names
//                           (defaults to CLAUDE_CODE_SESSION_ID, first 8 chars)
//   MURMUR_WAKE_CURSOR      file holding the last-drained inbound rowid
//   MURMUR_WAKE_LOCK        single-poller lock file
//   MURMUR_WAKE_MAX_SECONDS poll lifetime in seconds (default 1200)
//   MURMUR_WAKE_POLL_MS     poll interval in ms (default 10000)

import { DatabaseSync } from "node:sqlite";
import {
  readFileSync, writeFileSync, renameSync, rmSync,
  openSync, closeSync, writeSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DB = process.env.MURMUR_DB || ".data/murmur.db";

// Session key: one cursor and one lock per Claude Code session. A shared cursor means
// the first session to reach the hook advances it past the message and every other live
// session — including the one holding the conversation — never sees it (see
// murmur-coldidle-watch.sh for the measurement that produced this).
const SESSION_KEY = (process.env.MURMUR_WAKE_SESSION_KEY || process.env.CLAUDE_CODE_SESSION_ID || "").slice(0, 8);
const suffix = SESSION_KEY ? `-${SESSION_KEY}` : "";
const CURSOR = process.env.MURMUR_WAKE_CURSOR || join(HOME, `.murmur-wake-cursor${suffix}`);
const LOCK = process.env.MURMUR_WAKE_LOCK || join(HOME, `.murmur-wake-lock${suffix}`);
const MAX_SECONDS = Number(process.env.MURMUR_WAKE_MAX_SECONDS || 1200);
const POLL_MS = Number(process.env.MURMUR_WAKE_POLL_MS || 10000);
const ONCE = process.argv.includes("--once");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCursor() {
  try {
    const v = parseInt(readFileSync(CURSOR, "utf8").trim(), 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeCursor(v) {
  const tmp = `${CURSOR}.${process.pid}`;
  try {
    writeFileSync(tmp, `${v}\n`);
    renameSync(tmp, CURSOR);
  } catch {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

function openDb() {
  // read-only; WAL lets us read while the daemon writes.
  return new DatabaseSync(DB, { readOnly: true });
}

function maxInbound(db) {
  const row = db.prepare(
    "SELECT COALESCE(MAX(rowid), 0) AS m FROM local_messages WHERE direction='inbound'",
  ).get();
  return row?.m ?? 0;
}

function newRows(db, since) {
  return db.prepare(
    `SELECT rowid, sender,
            substr(replace(replace(text, char(10), ' '), char(13), ' '), 1, 360) AS snippet
       FROM local_messages
      WHERE direction='inbound' AND rowid > ?
      ORDER BY rowid`,
  ).all(since);
}

function emitAndExit(rows) {
  // Advance to the last row we are about to REPORT, never to the table's tip: a message
  // landing between the SELECT and the tip query would be skipped over by the cursor and
  // would then never wake anyone.
  writeCursor(rows[rows.length - 1].rowid);
  releaseLock();
  const lines = rows.map((r) => `  rowid=${r.rowid} [${r.sender}] ${r.snippet}`);
  process.stderr.write(
    `Murmur wake: ${rows.length} new inbound message(s):\n${lines.join("\n")}\n` +
    `Reply via murmur_send or act on them.\n`,
  );
  process.exit(2);
}

// --- single-poller lock (poll mode only) ------------------------------------
let haveLock = false;
function acquireLock() {
  try {
    // stale lock (older than a full lifetime + slack) → take over
    try {
      const age = (Date.now() - statSync(LOCK).mtimeMs) / 1000;
      if (age > MAX_SECONDS + 120) rmSync(LOCK, { force: true });
    } catch {}
    const fd = openSync(LOCK, "wx"); // fail if exists
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    haveLock = true;
    return true;
  } catch {
    return false; // another poller is alive
  }
}
function releaseLock() {
  if (haveLock) { try { rmSync(LOCK, { force: true }); } catch {} haveLock = false; }
}

// Never exit non-zero on a fault: that would wake the session with a false alarm. But
// never exit SILENTLY either — a hook that dies without a word is the exact failure this
// script exists to fix. One line on stderr is visible when run by hand and harmless to
// the harness at exit 0.
function bail(what, err) {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  process.stderr.write(`murmur wake: ${what}${detail ? `: ${detail}` : ""} (db=${DB})\n`);
  releaseLock();
  process.exit(0);
}

async function main() {
  // DB not present (daemon never started) → nothing to do, and say which path was tried.
  try { statSync(DB); } catch (err) { bail("store not readable", err); }

  // First run ever: establish a baseline at the current tip, do not dump history.
  let cursorExists = true;
  try { statSync(CURSOR); } catch { cursorExists = false; }
  if (!cursorExists) {
    const db = openDb();
    const tip = maxInbound(db);
    db.close();
    writeCursor(tip);
    process.exit(0);
  }

  if (ONCE) {
    const db = openDb();
    const since = readCursor();
    const rows = newRows(db, since);
    db.close();
    if (rows.length) emitAndExit(rows);
    process.exit(0);
  }

  // poll mode: only one poller at a time
  if (!acquireLock()) process.exit(0);
  process.on("exit", releaseLock);

  const deadline = Date.now() + MAX_SECONDS * 1000;
  while (Date.now() < deadline) {
    const db = openDb();
    const since = readCursor();
    const rows = newRows(db, since);
    db.close();
    if (rows.length) emitAndExit(rows);
    await sleep(POLL_MS);
  }
  releaseLock();
  process.exit(0);
}

main().catch((err) => bail("drain failed", err));
