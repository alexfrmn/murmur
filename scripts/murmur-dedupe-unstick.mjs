#!/usr/bin/env node
/**
 * murmur-dedupe-unstick.mjs — release messages stuck in the dedupe table.
 *
 * A message the daemon could not verify is marked as seen. Every later delivery of it is
 * then answered with `duplicate-ignored`, so the sender never gets a settlement and keeps
 * retrying — for as long as both sides are running. Since 2.8.1 an `unknown-sender`
 * rejection no longer takes that path, and `murmur-add-peer` clears what a missing peer
 * held back. This script covers the two cases that leaves:
 *
 *   - rows written before 2.8.1, which carry no sender and cannot be selected by peer;
 *   - a peer whose messages you want released without re-running the invite handshake.
 *
 * Usage:
 *   node scripts/murmur-dedupe-unstick.mjs --from <agentId>
 *   node scripts/murmur-dedupe-unstick.mjs --msg-id <uuid> [--msg-id <uuid> ...]
 *   node scripts/murmur-dedupe-unstick.mjs --list           # show what is held, change nothing
 *
 * Env: DATA_DIR (default: .data)
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { SQLiteDedupeOutboxStore } from "@murmurv2/core";

const args = process.argv.slice(2);
const msgIds = [];
let from;
let list = false;

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--from") from = args[++i];
  else if (args[i] === "--msg-id") msgIds.push(args[++i]);
  else if (args[i] === "--list") list = true;
  else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}

if (!list && !from && msgIds.length === 0) {
  console.error("Usage: murmur-dedupe-unstick.mjs (--list | --from <agentId> | --msg-id <uuid> ...)");
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || ".data";
const dbPath = path.join(dataDir, "murmur.db");
if (!existsSync(dbPath)) {
  console.error(`[unstick] No database at ${dbPath}. Set DATA_DIR to the daemon's data directory.`);
  process.exit(1);
}

if (list) {
  // Read-only view. Held rows are the ones a retry can never get past on its own.
  const db = new DatabaseSync(dbPath);
  const columns = db.prepare("PRAGMA table_info(dedupe_seen)").all().map((c) => c.name);
  const hasOrigin = columns.includes("poison_reason");
  const rows = hasOrigin
    ? db
        .prepare(
          `SELECT msg_id, consumer_id, seen_at, sender_agent_id, poison_reason
           FROM dedupe_seen WHERE poison_reason IS NOT NULL ORDER BY seen_at`,
        )
        .all()
    : db.prepare("SELECT msg_id, consumer_id, seen_at FROM dedupe_seen ORDER BY seen_at").all();

  if (!hasOrigin) {
    console.log("[unstick] This database predates 2.8.1: rows carry no sender or reason.");
    console.log("[unstick] Listing every dedupe row; release the ones you recognise with --msg-id.");
  }
  if (rows.length === 0) {
    console.log("[unstick] Nothing held back.");
  }
  for (const r of rows) {
    const origin = r.sender_agent_id ? ` from=${r.sender_agent_id}` : "";
    const reason = r.poison_reason ? ` reason=${r.poison_reason}` : "";
    console.log(`${r.seen_at}  ${r.msg_id}  consumer=${r.consumer_id}${origin}${reason}`);
  }
  process.exit(0);
}

const store = new SQLiteDedupeOutboxStore(dbPath);
let cleared = 0;
if (from) cleared += await store.clearPoisonedFrom(from);
if (msgIds.length > 0) cleared += await store.clearPoisonedMsgIds(msgIds);

console.log(`[unstick] Released ${cleared} message(s).`);
if (cleared > 0) {
  console.log("Restart the daemon so the next delivery is accepted:");
  console.log("  sudo systemctl restart murmur-daemon");
}
