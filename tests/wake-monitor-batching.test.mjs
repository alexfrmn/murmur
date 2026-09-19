import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { WakeMonitor, normalizeWakeConfig } from "../scripts/wake-monitor.mjs";

const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-batch-"));
  const store = new SQLiteMessageStore(join(dir, "murmur.db"));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const receive = async (msgId, extra = {}) => {
    const row = await store.append({ msgId, sender: "peer", direction: "inbound", conversationId: "conv", text: `text:${msgId}`, createdAt: new Date().toISOString(), wakeEligible: true, ...extra });
    return { ...row, from: row.sender, cursor: row.rowid };
  };
  return { store, receive, dbPath: join(dir, "murmur.db") };
};
const peer = { mode: "codex_app_server", steer_batch_window_ms: 20, steer_max_per_turn: 3 };
const monitorFor = (store, injector, options = {}) => new WakeMonitor({
  deliveries: store, peers: { peer }, injector,
  loopBreaker: { maxWakes: 100, windowMs: 60000 }, ...options,
});

test("batching config is opt-in and validates bounded per-peer limits", () => {
  assert.equal(normalizeWakeConfig({ wake: { peers: { peer: {} } } }).peers.peer.steer_batch_window_ms, undefined);
  const normalized = normalizeWakeConfig({ wake: { peers: { peer } } }).peers.peer;
  assert.equal(normalized.steer_batch_window_ms, 20);
  assert.equal(normalized.steer_max_per_turn, 3);
  assert.throws(() => normalizeWakeConfig({ wake: { peers: { peer: { steer_batch_window_ms: -1 } } } }), /batch/);
  assert.throws(() => normalizeWakeConfig({ wake: { peers: { peer: { steer_max_per_turn: 101 } } } }), /batch/);
});

test("without opt-in each durable message keeps its own turn", async (t) => {
  const { store, receive } = fixture(t);
  const calls = [];
  const monitor = monitorFor(store, async (p) => calls.push(p.msgId), { peers: { peer: { mode: "codex_app_server" } } });
  for (const id of ["one", "two", "three"]) monitor.enqueue(await receive(id));
  await monitor.drain();
  assert.deepEqual(calls, ["one", "two", "three"]);
});

test("quiet window coalesces FIFO messages and leaves overflow for another turn", async (t) => {
  const { store, receive } = fixture(t);
  const calls = [];
  const monitor = monitorFor(store, async (p) => { calls.push(p); return { replyMsgId: `reply:${p.msgId}` }; });
  for (const id of ["one", "two", "three", "four"]) monitor.enqueue(await receive(id));
  await monitor.drain();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].batchMsgIds, ["one", "two", "three"]);
  assert.equal(calls[1].msgId, "four");
  assert.ok(calls[0].text.indexOf("text:one") < calls[0].text.indexOf("text:two"));
  for (const id of ["one", "two", "three", "four"]) assert.equal((await store.wakeStateFor(id)).status, "handled");
});

test("messages queued during a running turn coalesce only after it completes", async (t) => {
  const { store, receive } = fixture(t);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const calls = [];
  const monitor = monitorFor(store, async (p) => {
    calls.push(p);
    if (p.msgId === "first") { started(); await blocked; }
  });
  const draining = monitor.onInbound(await receive("first"));
  await running;
  await monitor.onInbound(await receive("second"));
  await monitor.onInbound(await receive("third"));
  await delay(30);
  assert.equal(calls.length, 1);
  release();
  await draining;
  assert.deepEqual(calls[1].batchMsgIds, ["second", "third"]);
});

test("restart before dispatch recovers the pending messages from SQLite", async (t) => {
  const { store, receive } = fixture(t);
  const abandoned = monitorFor(store, async () => assert.fail("old session must not run"));
  abandoned.enqueue(await receive("one"));
  abandoned.enqueue(await receive("two"));
  const calls = [];
  const restarted = monitorFor(store, async (p) => calls.push(p));
  await restarted.drain();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].batchMsgIds, ["one", "two"]);
});

for (const settlementDelay of [0, 150]) test(`failed batch keeps its identity across restart and new arrivals (settlement delay ${settlementDelay}ms)`, async (t) => {
  const { store, receive } = fixture(t);
  let clock = Date.parse("2026-09-19T12:00:00.000Z");
  const options = { now: () => clock, peers: { peer: { ...peer, steer_batch_window_ms: 0 } } };
  const settle = store.settleWakeBatch.bind(store);
  let settlements = 0;
  store.settleWakeBatch = async (outcomes) => {
    await settle(outcomes);
    // A slow first settlement can make the first retry due before drain returns.
    if (++settlements === 1) clock += settlementDelay;
  };
  let failedId;
  const failing = monitorFor(store, async (p) => { failedId = p.msgId; throw new Error("session-gone"); }, { ...options, retryBackoffMs: 100 });
  failing.enqueue(await receive("one"));
  failing.enqueue(await receive("two"));
  await failing.drain();
  const one = await store.wakeStateFor("one"), two = await store.wakeStateFor("two");
  assert.equal(one.status, "failed");
  assert.equal(two.status, "failed");
  assert.equal(one.attempts, settlementDelay ? 2 : 1);
  assert.equal(one.nextAttemptAt, two.nextAttemptAt);
  await receive("new");
  // Retry backoff grows with attempts. A fixed sleep can restart before the saved
  // deadline after a slow drain; this test concerns identity once the retry is due.
  clock = Date.parse(one.nextAttemptAt);
  const calls = [];
  const restarted = monitorFor(store, async (p) => calls.push(p), options);
  await restarted.drain();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].msgId, failedId);
  assert.deepEqual(calls[0].batchMsgIds, ["one", "two"]);
  assert.equal(calls[1].msgId, "new");
});

test("batching never mixes conversations, members, or muted messages", async (t) => {
  const { store, receive } = fixture(t);
  const calls = [];
  const monitor = monitorFor(store, async (p) => calls.push(p), { peers: { peer: { ...peer, threadId: "one-thread" } } });
  monitor.enqueue(await receive("one", { channelId: "channel", senderMemberId: "member-a" }));
  monitor.enqueue(await receive("two", { channelId: "channel", senderMemberId: "member-b" }));
  monitor.enqueue(await receive("three", { conversationId: "other" }));
  monitor.enqueue(await receive("muted", { wakeEligible: false }));
  await monitor.drain();
  assert.deepEqual(calls.map((p) => p.msgId), ["one", "two", "three"]);
  assert.equal((await store.wakeStateFor("muted")).status, "muted");
});

test("each message passes audit before one batch effect, and loop breaker counts effects", async (t) => {
  const { store, receive } = fixture(t);
  const audited = [];
  const calls = [];
  const monitor = monitorFor(store, async (p) => calls.push(p), {
    loopBreaker: { maxWakes: 1, windowMs: 60000 },
    auditHook: async (p) => { audited.push(p.msgId); return p.msgId === "denied" ? "deny" : "allow"; },
  });
  for (const id of ["one", "denied", "two"]) monitor.enqueue(await receive(id));
  await monitor.drain();
  assert.deepEqual(audited, ["one", "denied", "two"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].batchMsgIds, ["one", "two"]);
  assert.ok(!calls[0].text.includes("text:denied"));
  assert.equal((await store.wakeStateFor("denied")).status, "muted");
});

test("batch settlement rolls back all members when one update fails", async (t) => {
  const { store, receive } = fixture(t);
  await receive("one"); await receive("two");
  await store.claimWake("one"); await store.claimWake("two");
  await store.assignWakeBatch(["one", "two"]);
  store.db.exec(`CREATE TRIGGER fail_batch_settlement BEFORE UPDATE OF wake_status ON local_messages
    WHEN NEW.msg_id = 'two' AND NEW.wake_status = 'handled' BEGIN SELECT RAISE(ABORT, 'injected-write-failure'); END`);
  await assert.rejects(store.settleWakeBatch([
    { msgId: "one", input: { status: "handled" } },
    { msgId: "two", input: { status: "handled" } },
  ]), /injected-write-failure/);
  assert.equal((await store.wakeStateFor("one")).status, "inflight");
  assert.equal((await store.wakeStateFor("two")).status, "inflight");
  store.db.exec("DROP TRIGGER fail_batch_settlement");
  const calls = [];
  await monitorFor(store, async (p) => calls.push(p)).drain();
  assert.deepEqual(calls[0].batchMsgIds, ["one", "two"]);
  assert.equal((await store.wakeStateFor("one")).status, "handled");
  assert.equal((await store.wakeStateFor("two")).status, "handled");
});

test("killing a session during the quiet window leaves every message recoverable", { timeout: 15000 }, async (t) => {
  const { store, dbPath } = fixture(t);
  const coreUrl = new URL("../packages/core/dist/src/index.js", import.meta.url).href;
  const monitorUrl = new URL("../scripts/wake-monitor.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { SQLiteMessageStore } from ${JSON.stringify(coreUrl)};
    import { WakeMonitor } from ${JSON.stringify(monitorUrl)};
    const store = new SQLiteMessageStore(process.argv[1]);
    const monitor = new WakeMonitor({ deliveries: store,
      peers: { peer: { mode: 'codex_app_server', steer_batch_window_ms: 10000 } },
      injector: async () => { throw new Error('must-not-run-before-kill'); }
    });
    for (const msgId of ['one', 'two']) {
      const row = await store.append({ msgId, sender: 'peer', direction: 'inbound',
        conversationId: 'conv', text: msgId, createdAt: new Date().toISOString(), wakeEligible: true });
      void monitor.onInbound({ ...row, from: 'peer', cursor: row.rowid });
    }
    process.stdout.write('queued');
  `, dbPath], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal((await store.wakeStateFor("one")).status, "pending");
  assert.equal((await store.wakeStateFor("two")).status, "pending");
  const calls = [];
  await monitorFor(store, async (payload) => calls.push(payload)).drain();
  assert.deepEqual(calls[0].batchMsgIds, ["one", "two"]);
  assert.equal((await store.wakeStateFor("one")).status, "handled");
  assert.equal((await store.wakeStateFor("two")).status, "handled");
});

test("a failed batch shares one retry deadline even when the clock advances per member", async (t) => {
  const { store, receive } = fixture(t);
  let clock = Date.now();
  const monitor = monitorFor(store, async () => { throw new Error("retry"); }, { now: () => clock++, retryBackoffMs: 1000 });
  monitor.enqueue(await receive("one")); monitor.enqueue(await receive("two"));
  await monitor.drain();
  const one = await store.wakeStateFor("one"), two = await store.wakeStateFor("two");
  assert.equal(one.status, "failed");
  assert.equal(one.nextAttemptAt, two.nextAttemptAt);
  clock = Date.parse(one.nextAttemptAt);
  const calls = [];
  await monitorFor(store, async (p) => calls.push(p), { now: () => clock }).drain();
  assert.equal(calls.length, 1);
  assert.equal((await store.wakeStateFor("two")).status, "handled");
});

test("mixed prior attempt counts cannot split a batch into DLQ and retryable members", async (t) => {
  const { store, receive } = fixture(t);
  const one = await receive("one");
  await store.claimWake("one");
  await store.settleWake("one", { status: "failed", nextAttemptAt: "2000-01-01T00:00:00Z" });
  const two = await receive("two");
  const monitor = monitorFor(store, async () => { throw new Error("session-gone"); }, { maxAttempts: 2 });
  monitor.enqueue(one); monitor.enqueue(two);
  await monitor.drain();
  assert.equal((await store.wakeStateFor("one")).status, "dlq");
  assert.equal((await store.wakeStateFor("two")).status, "dlq");
});
