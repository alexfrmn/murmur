import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";

const envelope = {
  schemaVersion: "1.0",
  msgId: "msg-busy-1",
  conversationId: "conv-1",
  senderAgentId: "agent.a",
  recipients: ["agent.b"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("x").toString("base64"),
  payloadNonce: "nonce",
  signature: "sig",
};

// #122: the daemon flushes the outbox while the MCP server enqueues into the same file.
// node:sqlite is synchronous, so the lock holder has to live in another process — exactly
// the production shape. Without a busy timeout the second writer fails at once with
// "database is locked" even though a few hundred milliseconds later the write would land.
test("SQLite outbox enqueue waits out a short write lock held by another process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-busy-"));
  const dbPath = join(dir, "murmur.db");
  const store = new SQLiteDedupeOutboxStore(dbPath);

  const holder = spawn(process.execPath, [
    "--no-warnings",
    "-e",
    `const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(process.argv[1]);
     db.exec("BEGIN IMMEDIATE");
     process.stdout.write("locked\\n");
     setTimeout(() => { db.exec("COMMIT"); process.exit(0); }, 400);`,
    dbPath,
  ]);
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    holder.once("error", reject);
    holder.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });

  const started = Date.now();
  await store.enqueue("msg.agent-b", envelope);
  const waited = Date.now() - started;

  await new Promise((r) => holder.once("exit", r));
  const row = new DatabaseSync(dbPath).prepare("SELECT status FROM outbox WHERE msg_id = ?").get(envelope.msgId);
  assert.equal(row.status, "pending");
  assert.ok(waited >= 200, `enqueue should have waited for the lock, waited ${waited}ms`);
});
