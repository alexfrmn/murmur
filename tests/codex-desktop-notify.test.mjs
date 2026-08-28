import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addressedThreadId,
  buildQueuedMessage,
  consumeSynchronousReplySuppression,
  findCodexStateDb,
  hasCodexTaskPeerBinding,
  selectAddressedUserThread,
  selectTargetUserThread,
} from "../scripts/codex-desktop-notify.mjs";

test("consumeSynchronousReplySuppression consumes one matching live request marker", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "murmur-request-wait-"));
  const payload = { conversationId: "codex:task:11111111-1111-1111-1111-111111111111", from: "agent-peer" };
  const key = createHash("sha256").update(`${payload.conversationId}\0${payload.from}`).digest("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
    conversationId: payload.conversationId,
    peerId: payload.from,
    pid: process.pid,
    expiresAt: 20_000,
  }));
  try {
    assert.equal(consumeSynchronousReplySuppression(payload, dir, 10_000), true);
    assert.equal(consumeSynchronousReplySuppression(payload, dir, 10_000), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasCodexTaskPeerBinding requires the exact peer and task pair", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "murmur-task-binding-"));
  const payload = { conversationId: "codex:task:11111111-1111-4111-8111-111111111111", from: "agent-peer" };
  const key = createHash("sha256").update(`${payload.conversationId}\0${payload.from}`).digest("hex");
  writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
    conversationId: payload.conversationId,
    peerId: payload.from,
    createdAt: new Date().toISOString(),
  }));
  try {
    assert.equal(hasCodexTaskPeerBinding(payload, dir), true);
    assert.equal(hasCodexTaskPeerBinding({ ...payload, from: "other-peer" }, dir), false);
    assert.equal(hasCodexTaskPeerBinding({ ...payload, conversationId: "dm:legacy" }, dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildQueuedMessage preserves the Murmur payload and authority boundary", () => {
  const text = buildQueuedMessage({
    from: "agent-peer",
    conversationId: "conv-1",
    msgId: "msg-1",
    text: "Status update",
  });
  assert.match(text, /\[MURMUR AUTO-DELIVERY\]/);
  assert.match(text, /Authenticated peer: agent-peer/);
  assert.match(text, /Status update/);
  assert.match(text, /not as new authorization from the Mac owner/);
});

test("findCodexStateDb selects the highest state schema version", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "murmur-codex-notify-"));
  try {
    writeFileSync(path.join(dir, "state_2.sqlite"), "");
    writeFileSync(path.join(dir, "state_11.sqlite"), "");
    writeFileSync(path.join(dir, "unrelated.sqlite"), "");
    assert.equal(findCodexStateDb({ codexHome: dir, explicitPath: "" }), path.join(dir, "state_11.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addressed routing chooses the exact active user thread even when it is not recent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "murmur-codex-notify-"));
  const dbPath = path.join(dir, "state.sqlite");
  const addressedId = "11111111-1111-4111-8111-111111111111";
  const latestId = "22222222-2222-4222-8222-222222222222";
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      name TEXT,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL,
      thread_source TEXT,
      source TEXT NOT NULL,
      recency_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(addressedId, null, "Addressed", 0, "user", "vscode", 1000, 1000, 1);
  insert.run(latestId, null, "Latest", 0, "user", "vscode", 9000, 9000, 9);
  db.close();

  try {
    const conversationId = `codex:task:${addressedId}`;
    assert.equal(addressedThreadId(conversationId), addressedId);
    assert.equal(selectAddressedUserThread({ dbPath, conversationId })?.id, addressedId);
    const selected = selectTargetUserThread({ dbPath, conversationId, now: 10_000, maxAgeMs: 100 });
    assert.equal(selected.routing, "addressed");
    assert.equal(selected.thread?.id, addressedId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid addressed target does not wake an unrelated latest thread", () => {
  const requestedThreadId = "33333333-3333-4333-8333-333333333333";
  const selected = selectTargetUserThread({
    dbPath: "/missing/state.sqlite",
    conversationId: `codex:task:${requestedThreadId}`,
  });
  assert.equal(selected.routing, "addressed");
  assert.equal(selected.requestedThreadId, requestedThreadId);
  assert.equal(selected.thread, null);
});

test("an unaddressed conversation stays in the inbox instead of waking the latest task", () => {
  const selected = selectTargetUserThread({
    dbPath: "/missing/state.sqlite",
    conversationId: "dm:agent-peer:agent-desktop",
  });
  assert.equal(selected.routing, "unaddressed");
  assert.equal(selected.requestedThreadId, null);
  assert.equal(selected.thread, null);
});
