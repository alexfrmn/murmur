#!/usr/bin/env node
/**
 * murmur-add-peer.mjs — Add a peer using their reply blob.
 * Completes the invite handshake.
 *
 * Usage: node scripts/murmur-add-peer.mjs MURMUR-REPLY:eyJ...
 * Env: DATA_DIR (default: .data)
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { SQLiteDedupeOutboxStore } from "@murmurv2/core";
import { readPrivateJson, writePrivateJson } from "./secure-state.mjs";

const blob = process.argv[2];
if (!blob || !blob.startsWith("MURMUR-REPLY:")) {
  console.error("Usage: node scripts/murmur-add-peer.mjs MURMUR-REPLY:eyJ...");
  console.error("Get the reply blob from your peer after they ran murmur-join.mjs");
  process.exit(1);
}

// Decode reply
let reply;
try {
  reply = JSON.parse(Buffer.from(blob.slice(13), "base64").toString("utf8"));
  if (reply.type !== "reply" || !reply.agentId) throw new Error("bad format");
} catch {
  console.error("[add-peer] Invalid reply blob. Make sure you copied the full MURMUR-REPLY:... string.");
  process.exit(1);
}

// Load config
const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");

let config;
try {
  config = await readPrivateJson(configPath);
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
  console.error("[add-peer] No agent config found. Run first: node scripts/agent-config-init.mjs");
  process.exit(1);
}

// Add peer
if (!config.peers) config.peers = {};
config.peers[reply.agentId] = {
  encryption: { publicKey: reply.encryption.publicKey },
  signing: { publicKey: reply.signing.publicKey },
  subject: reply.subject,
};

await writePrivateJson(configPath, config);

console.log(`[add-peer] Added: ${reply.agentId} (${reply.subject})`);

// Письма, отбитые пока этого пира не было в конфиге, лежат в dedupe как отравленные и
// сами оттуда не выйдут: каждая следующая доставка отбивается как duplicate-ignored.
// Причина только что снята — снимаем и отметку, иначе add-peer чинит связь на будущее,
// а всё пришедшее до него остаётся потерянным навсегда.
const dbPath = path.join(dataDir, "murmur.db");
if (existsSync(dbPath)) {
  try {
    const store = new SQLiteDedupeOutboxStore(dbPath);
    const cleared = await store.clearPoisonedFrom(reply.agentId);
    if (cleared > 0) {
      console.log(`[add-peer] Unstuck ${cleared} message(s) held back while this peer was unknown.`);
    }
  } catch (err) {
    // Не повод валить добавление пира: связь уже записана и работает.
    console.warn(`[add-peer] Could not clear held-back messages: ${err?.message ?? err}`);
  }
}

console.log("");
console.log("Connection complete! Restart your daemon if running:");
console.log("  sudo systemctl restart murmur-daemon");
