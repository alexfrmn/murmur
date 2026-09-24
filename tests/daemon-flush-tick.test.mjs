// A wake turn can last many minutes. The delivery loop must keep sending letters and
// notifications meanwhile: on 24.09 a ping from the Mac waited in the outbox from 11:29
// to 11:36 because the loop awaited the wake drain before its next flush.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";
import { flushTick } from "../scripts/daemon-flush-tick.mjs";

const quick = (promise, ms = 200) => Promise.race([
  promise.then(() => "done"),
  new Promise((resolve) => setTimeout(() => resolve("blocked"), ms)),
]);

test("a wake drain that never finishes does not hold the next outbox flush", async () => {
  const calls = [];
  const deps = {
    flushOutbox: async () => { calls.push("outbox"); },
    flushNotify: async () => { calls.push("notify"); },
    drainWake: () => { calls.push("drain"); return new Promise(() => {}); },
    log: () => {},
  };
  for (let i = 0; i < 3; i++) assert.equal(await quick(flushTick(deps)), "done", `tick ${i + 1} must not wait for the wake turn`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((c) => c === "outbox").length, 3);
  assert.deepEqual(calls.filter((c) => c === "drain").length, 3);
  assert.ok(calls.indexOf("outbox") < calls.indexOf("notify"), "letters go out before notifications");
});

test("drain failures, thrown or rejected, are logged and never break the tick", async () => {
  for (const drainWake of [() => { throw new Error("sync boom"); }, () => Promise.reject(new Error("async boom"))]) {
    const logged = [];
    let outbox = 0;
    await flushTick({
      flushOutbox: async () => { outbox++; },
      flushNotify: async () => {},
      drainWake,
      log: (level, message, fields) => logged.push({ level, message, error: fields?.error }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outbox, 1);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].message, "Wake retry drain error");
    assert.match(logged[0].error, /boom/);
  }
});

test("an outbox or notify failure is logged and the rest of the tick still runs", async () => {
  const logged = [];
  const ran = [];
  await flushTick({
    flushOutbox: async () => { throw new Error("broker down"); },
    flushNotify: async () => { ran.push("notify"); throw new Error("notify down"); },
    drainWake: async () => { ran.push("drain"); },
    log: (level, message) => logged.push(message),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logged, ["Outbox flush error", "Notify flush error"]);
  assert.deepEqual(ran, ["notify", "drain"]);
});

// Real store and WakeMonitor, drain started on every tick (independent review of #257).
test("a long turn keeps the outbox moving without a second wake or reordering in its conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flush-tick-"));
  const store = new SQLiteMessageStore(join(dir, "murmur.db"));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const calls = [], active = new Map(), gates = new Map();
  let maxLane = 0, outbox = 0, running = true;
  const receive = async (msgId, conversationId) => {
    const row = await store.append({ conversationId, msgId, direction: "inbound", sender: "agent-peer",
      text: msgId, createdAt: new Date().toISOString(), transport: "nats", wakeEligible: true });
    return { from: row.sender, text: row.text, msgId: row.msgId, conversationId, wakeEligible: true, cursor: row.rowid };
  };
  const monitor = new WakeMonitor({ deliveries: store, log: () => {},
    hook: async (payload) => {
      calls.push(payload.msgId);
      const lane = (active.get(payload.conversationId) ?? 0) + 1;
      active.set(payload.conversationId, lane); maxLane = Math.max(maxLane, lane);
      if (gates.has(payload.msgId)) await gates.get(payload.msgId).promise; else await sleep(5);
      active.set(payload.conversationId, active.get(payload.conversationId) - 1);
    } });
  let release;
  gates.set("m1", { promise: new Promise((resolve) => { release = resolve; }) });
  const loop = (async () => {
    while (running) {
      await flushTick({ flushOutbox: async () => { outbox++; }, flushNotify: async () => {},
        drainWake: () => monitor.drain(), log: () => {} });
      await sleep(5);
    }
  })();
  try {
    await receive("m1", "c1");
    await sleep(60);
    const before = outbox;
    for (const [msgId, conversationId] of [["m2", "c1"], ["n1", "c2"], ["m3", "c1"]]) {
      monitor.onInbound(await receive(msgId, conversationId)).catch(() => {});
      await sleep(20);
    }
    await sleep(200);
    assert.ok(outbox - before >= 3, `outbox flushes during the turn: ${outbox - before}`);
    assert.ok(calls.includes("n1"), "another conversation is woken meanwhile");
    assert.ok(!calls.includes("m2"), "the same conversation waits behind m1");
    release();
    await sleep(300);
    running = false; await loop;
    assert.deepEqual(calls.filter((id) => id !== "n1"), ["m1", "m2", "m3"]);
    assert.equal(new Set(calls).size, calls.length, `no duplicate wakes: ${calls}`);
    assert.equal(maxLane, 1);
    for (const id of ["m1", "m2", "m3", "n1"]) assert.equal((await store.wakeStateFor(id)).status, "handled");
  } finally {
    release(); running = false; await loop;
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
