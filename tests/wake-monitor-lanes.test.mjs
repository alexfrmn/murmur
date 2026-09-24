import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { WakeMonitor, normalizeWakeConfig } from "../scripts/wake-monitor.mjs";

// #107 — `drain()` was one sequential loop: a long turn for one peer held every other
// inbound message until it finished or timed out (measured: a short question waited 90 s
// behind a long turn). Wakes now run in lanes — one lane per peer/conversation, several
// lanes at once — so order is kept where it matters and lost nowhere else.

const withStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-wake-lanes-"));
  const store = new SQLiteMessageStore(join(dir, "murmur.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const receive = async (store, msgId, from, conversationId = `dm:${from}:me`) => {
  const row = await store.append({
    conversationId,
    msgId,
    direction: "inbound",
    sender: from,
    text: `text ${msgId}`,
    createdAt: new Date().toISOString(),
    transport: "nats",
    wakeEligible: true,
  });
  return { from, text: row.text, msgId, conversationId, wakeEligible: true, cursor: row.rowid };
};

const until = async (predicate, { timeoutMs = 2000, stepMs = 10 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
};

const gate = () => {
  let release;
  const opened = new Promise((resolve) => { release = resolve; });
  return { opened, release };
};

test("a long wake from one peer no longer blocks a short wake from another", async () => {
  const { store, cleanup } = withStore();
  try {
    const slow = gate();
    const done = [];
    const monitor = new WakeMonitor({
      deliveries: store,
      hook: async (payload) => {
        if (payload.from === "agent-slow") await slow.opened;
        done.push(payload.msgId);
      },
    });

    const first = monitor.onInbound(await receive(store, "slow-1", "agent-slow"));
    const second = monitor.onInbound(await receive(store, "fast-1", "agent-fast"));

    const fastHandled = await until(async () => (await store.wakeStateFor("fast-1"))?.status === "handled");
    assert.ok(fastHandled, "the short wake must complete while the long one is still running");
    assert.equal((await store.wakeStateFor("slow-1")).status, "inflight");
    assert.deepEqual(done, ["fast-1"]);

    slow.release();
    await Promise.all([first, second]);
    assert.deepEqual(done, ["fast-1", "slow-1"]);
  } finally {
    cleanup();
  }
});

test("messages from the same peer and conversation stay in order and never overlap", async () => {
  const { store, cleanup } = withStore();
  try {
    const order = [];
    let inflight = 0;
    let maxInflight = 0;
    const monitor = new WakeMonitor({
      deliveries: store,
      hook: async (payload) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, payload.msgId === "a-1" ? 40 : 5));
        order.push(payload.msgId);
        inflight -= 1;
      },
    });

    const runs = [];
    for (const id of ["a-1", "a-2", "a-3"]) runs.push(monitor.onInbound(await receive(store, id, "agent-a")));
    await Promise.all(runs);
    await monitor.drain();

    assert.deepEqual(order, ["a-1", "a-2", "a-3"]);
    assert.equal(maxInflight, 1);
  } finally {
    cleanup();
  }
});

test("concurrency: 1 keeps the sequential behaviour", async () => {
  const { store, cleanup } = withStore();
  try {
    const slow = gate();
    const done = [];
    const monitor = new WakeMonitor({
      deliveries: store,
      concurrency: 1,
      hook: async (payload) => {
        if (payload.from === "agent-slow") await slow.opened;
        done.push(payload.msgId);
      },
    });

    const first = monitor.onInbound(await receive(store, "slow-1", "agent-slow"));
    const second = monitor.onInbound(await receive(store, "fast-1", "agent-fast"));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(done, [], "with one lane the second wake waits for the first");

    slow.release();
    await Promise.all([first, second]);
    assert.deepEqual(done, ["slow-1", "fast-1"]);
  } finally {
    cleanup();
  }
});

test("the lane cap bounds how many wakes run at once", async () => {
  const { store, cleanup } = withStore();
  try {
    const gates = new Map();
    let inflight = 0;
    let maxInflight = 0;
    const monitor = new WakeMonitor({
      deliveries: store,
      concurrency: 2,
      hook: async (payload) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        const g = gate();
        gates.set(payload.msgId, g);
        await g.opened;
        inflight -= 1;
      },
    });

    const runs = [];
    for (const peer of ["agent-a", "agent-b", "agent-c"]) runs.push(monitor.onInbound(await receive(store, `${peer}-1`, peer)));
    await until(async () => gates.size === 2);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(gates.size, 2, "the third wake waits for a free lane");

    for (const g of gates.values()) g.release();
    await until(async () => gates.size === 3);
    for (const g of gates.values()) g.release();
    await Promise.all(runs);

    assert.equal(maxInflight, 2);
  } finally {
    cleanup();
  }
});

test("normalizeWakeConfig carries the lane count through, defaulting to 4", () => {
  assert.equal(normalizeWakeConfig({ wake: { concurrency: 8 } }).concurrency, 8);
  assert.equal(normalizeWakeConfig({}).concurrency, 4);
});

test("a getWakeBatch read failure cannot release another conversation's active lane", async () => {
  const { store, cleanup } = withStore();
  const slow = gate(), calls = [], runs = [];
  let active = 0, maxLane = 0, reads = 0;
  const getWakeBatch = store.getWakeBatch.bind(store);
  store.getWakeBatch = async (msgId) => {
    if (msgId === "n1" && ++reads === 1) throw new Error("SQLITE_BUSY");
    return getWakeBatch(msgId);
  };
  const monitor = new WakeMonitor({ deliveries: store, hook: async (payload) => {
    calls.push(payload.msgId);
    if (payload.conversationId === "c1") {
      active += 1; maxLane = Math.max(maxLane, active);
      if (payload.msgId === "m1") await slow.opened;
      active -= 1;
    }
  } });
  const track = (run) => { const result = run.catch(error => error); runs.push(result); return result; };
  try {
    track(monitor.onInbound(await receive(store, "m1", "agent-a", "c1")));
    assert.ok(await until(() => calls.includes("m1")));
    await monitor.onInbound(await receive(store, "m2", "agent-a", "c1"));
    await monitor.onInbound(await receive(store, "n1", "agent-a", "c2"));
    assert.ok(await until(() => reads === 1));
    // The timer in #257 calls drain again without waiting for the first one.
    track(monitor.drain());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(maxLane, 1, "SQLITE_BUSY must not allow a second turn in c1");
    assert.equal(monitor.processing, true);
    assert.deepEqual(calls, ["m1"]);
    assert.equal((await store.wakeStateFor("n1")).status, "pending");
    slow.release();
    await Promise.all(runs); await monitor.drain();
    assert.equal(maxLane, 1);
    assert.deepEqual(calls, ["m1", "m2", "n1"]);
    assert.ok(reads >= 2, "the failed conversation is offered again");
    for (const id of ["m1", "m2", "n1"]) assert.equal((await store.wakeStateFor(id)).status, "handled");
  } finally {
    monitor.enabled = false; slow.release();
    await Promise.all(runs); cleanup();
  }
});
