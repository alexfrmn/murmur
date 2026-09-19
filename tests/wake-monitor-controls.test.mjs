import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { WakeMonitor, createShellHook, normalizeWakeConfig } from "../scripts/wake-monitor.mjs";

const epoch = Date.parse("2026-09-19T12:00:00Z");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "murmur-wake-controls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SQLiteMessageStore(join(dir, "murmur.db"));
  const clock = { now: epoch };
  const options = { deliveries: store, now: () => clock.now, retryBackoffMs: 100, maxAttempts: 2 };
  const receive = async (msgId) => {
    const row = await store.append({ msgId, conversationId: "controls", direction: "inbound",
      sender: "peer", text: "hello", createdAt: new Date(epoch).toISOString(), wakeEligible: true });
    return { msgId, from: row.sender, text: row.text, conversationId: row.conversationId, cursor: row.rowid };
  };
  return { store, clock, options, receive };
}

test("disabled timer drain preserves pending backlog and attempts; enable resumes it once", async (t) => {
  const { store, options, receive } = fixture(t);
  const calls = [];
  const monitor = new WakeMonitor({ ...options, enabled: false, hook: async (p) => calls.push(p.msgId) });
  await monitor.onInbound(await receive("paused"));
  await monitor.drain();
  await monitor.drain();
  assert.deepEqual(calls, []);
  const paused = await store.wakeStateFor("paused");
  assert.equal(paused.status, "pending");
  assert.equal(paused.attempts, 0);
  assert.equal(monitor.cursor, 0);
  monitor.enabled = true;
  await monitor.drain();
  await monitor.drain();
  assert.deepEqual(calls, ["paused"]);
  assert.equal((await store.wakeStateFor("paused")).status, "handled");
});

test("pausing during a lane leaves later queued work pending while its active hook finishes", async (t) => {
  const { store, options, receive } = fixture(t);
  const calls = [];
  const monitor = new WakeMonitor({ ...options, concurrency: 1, hook: async (p) => {
    calls.push(p.msgId);
    monitor.enabled = false;
  } });
  monitor.enqueue(await receive("first"));
  monitor.enqueue(await receive("later"));
  await monitor.drain();
  assert.deepEqual(calls, ["first"]);
  assert.equal((await store.wakeStateFor("first")).status, "handled");
  assert.equal((await store.wakeStateFor("later")).status, "pending");
});

for (const [label, hookOptions] of [
  ["nonzero exit", { command: "exit 7" }],
  ["timeout", { command: "exec sleep 2", timeoutMs: 30 }],
  ["missing shell", { command: "true", baseEnv: { PATH: "/murmur-test-no-shell" } }],
]) test(`shell hook ${label} keeps cursor at failure, retries and finally enters DLQ`, async (t) => {
  const { store, options, clock, receive } = fixture(t);
  const notices = [];
  const monitor = new WakeMonitor({ ...options, hook: createShellHook(hookOptions),
    notify: async (p, reason) => notices.push([p.msgId, reason]) });
  await monitor.onInbound(await receive("failed-hook"));
  const failed = await store.wakeStateFor("failed-hook");
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(monitor.cursor, 0);
  assert.match(failed.error, /^wake-hook-/);
  await monitor.drain();
  assert.equal((await store.wakeStateFor("failed-hook")).attempts, 1, "honor backoff");
  clock.now += 101;
  await monitor.drain();
  assert.equal((await store.wakeStateFor("failed-hook")).status, "dlq");
  assert.deepEqual(notices, [["failed-hook", "wake-dlq"]]);
});

test("no responder persists stored-only, never handled, and restart does not replay it", async (t) => {
  const { store, options, receive } = fixture(t);
  const monitor = new WakeMonitor(options);
  await monitor.onInbound(await receive("no-responder"));
  const state = await store.wakeStateFor("no-responder");
  assert.equal(state.status, "stored-only");
  assert.equal(state.error, "wake-no-responder");
  assert.equal(monitor.cursor, 1);
  const calls = [];
  await new WakeMonitor({ ...options, hook: async (p) => calls.push(p.msgId) }).drain();
  assert.deepEqual(calls, []);
});

test("wake hook timeout is configurable and rejects invalid limits", () => {
  assert.equal(normalizeWakeConfig().hookTimeoutMs, 10000);
  assert.equal(normalizeWakeConfig({ wake: { hookTimeoutMs: 120000 } }).hookTimeoutMs, 120000);
  for (const hookTimeoutMs of [0, -1, 1.5, Infinity, null, "1000"]) {
    assert.throws(() => normalizeWakeConfig({ wake: { hookTimeoutMs } }), /wake-hook-timeout-invalid/);
  }
});
