// A wake turn can last many minutes. The delivery loop must keep sending letters and
// notifications meanwhile: on 24.09 a ping from the Mac waited in the outbox from 11:29
// to 11:36 because the loop awaited the wake drain before its next flush.
import test from "node:test";
import assert from "node:assert/strict";
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
