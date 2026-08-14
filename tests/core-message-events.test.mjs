import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";

const withStore = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-events-"));
  try {
    await fn(new SQLiteMessageStore(join(dir, "murmur.db")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("recordEvent + traceMessage returns the lifecycle oldest-first", async () => {
  await withStore(async (store) => {
    await store.recordEvent({ msgId: "m1", conversationId: "c1", event: "queued", createdAt: "2026-08-14T10:00:00.000Z" });
    await store.recordEvent({ msgId: "m1", conversationId: "c1", event: "delivered", createdAt: "2026-08-14T10:00:01.000Z" });
    await store.recordEvent({ msgId: "m1", conversationId: "c1", event: "woke", actor: "agent-codex", createdAt: "2026-08-14T10:00:02.000Z" });
    await store.recordEvent({ msgId: "m1", conversationId: "c1", event: "handled", actor: "agent-codex", createdAt: "2026-08-14T10:00:03.000Z" });

    const trace = await store.traceMessage("m1");
    assert.deepEqual(trace.map((e) => e.event), ["queued", "delivered", "woke", "handled"]);
    assert.equal(trace[2].actor, "agent-codex");
  });
});

test("delivered without woke is visible as its own state", async () => {
  // The exact failure R-OPS-006 warns about: the broker accepted the envelope,
  // the peer never woke. Transport metrics call this a success.
  await withStore(async (store) => {
    await store.recordEvent({ msgId: "m2", event: "delivered", createdAt: "2026-08-14T10:00:00.000Z" });
    await store.recordEvent({
      msgId: "m2",
      event: "wake_failed",
      detail: "codex-app-server-connect-failed",
      createdAt: "2026-08-14T10:00:01.000Z",
    });

    const trace = await store.traceMessage("m2");
    assert.equal(trace.length, 2);
    assert.equal(trace.at(-1).event, "wake_failed");
    assert.equal(trace.at(-1).detail, "codex-app-server-connect-failed");
    assert.ok(!trace.some((e) => e.event === "woke"), "delivered must not imply woke");
  });
});

test("replied links question to answer through relatesTo", async () => {
  await withStore(async (store) => {
    await store.recordEvent({ msgId: "q1", conversationId: "c1", event: "delivered", createdAt: "2026-08-14T10:00:00.000Z" });
    await store.recordEvent({
      msgId: "q1",
      conversationId: "c1",
      event: "replied",
      actor: "agent-codex",
      relatesTo: "a1",
      createdAt: "2026-08-14T10:05:00.000Z",
    });

    const trace = await store.traceMessage("q1");
    const replied = trace.find((e) => e.event === "replied");
    assert.equal(replied.relatesTo, "a1");
  });
});

test("stalledOutbound finds delivered-but-unanswered and skips answered ones", async () => {
  await withStore(async (store) => {
    // answered — must not surface
    await store.recordEvent({ msgId: "ok1", conversationId: "c1", event: "delivered", createdAt: "2026-08-14T09:00:00.000Z" });
    await store.recordEvent({ msgId: "ok1", conversationId: "c1", event: "replied", relatesTo: "a9", createdAt: "2026-08-14T09:01:00.000Z" });
    // delivered, silent — must surface
    await store.recordEvent({ msgId: "stuck1", conversationId: "c2", event: "delivered", createdAt: "2026-08-14T09:00:00.000Z" });
    // recent — outside the window
    await store.recordEvent({ msgId: "fresh1", conversationId: "c3", event: "delivered", createdAt: "2026-08-14T23:59:00.000Z" });

    const stalled = await store.stalledOutbound("2026-08-14T12:00:00.000Z");
    const ids = stalled.map((r) => r.msgId);
    assert.deepEqual(ids, ["stuck1"]);
    assert.equal(stalled[0].lastEvent, "delivered");
    assert.equal(stalled[0].conversationId, "c2");
  });
});

test("traceConversation returns newest-first across messages", async () => {
  await withStore(async (store) => {
    await store.recordEvent({ msgId: "m1", conversationId: "c1", event: "queued", createdAt: "2026-08-14T10:00:00.000Z" });
    await store.recordEvent({ msgId: "m2", conversationId: "c1", event: "queued", createdAt: "2026-08-14T11:00:00.000Z" });
    await store.recordEvent({ msgId: "x1", conversationId: "other", event: "queued", createdAt: "2026-08-14T12:00:00.000Z" });

    const trace = await store.traceConversation("c1");
    assert.deepEqual(trace.map((e) => e.msgId), ["m2", "m1"]);
  });
});

test("events coexist with existing local_messages rows", async () => {
  // Additive migration: an existing database keeps working untouched.
  await withStore(async (store) => {
    await store.append({
      conversationId: "c1",
      msgId: "m1",
      direction: "outbound",
      sender: "agent-jarvis",
      text: "hello",
      createdAt: "2026-08-14T10:00:00.000Z",
    });
    await store.recordEvent({ msgId: "m1", conversationId: "c1", event: "delivered", createdAt: "2026-08-14T10:00:01.000Z" });

    const conversations = await store.listConversations();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].messageCount, 1);
    assert.equal((await store.traceMessage("m1")).length, 1);
  });
});
