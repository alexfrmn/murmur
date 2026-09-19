// A log line that cannot tell "woke somebody" from "nobody to wake".
//
// `WakeMonitor hook completed` used to be printed whether or not a hook existed, so a
// daemon configured with neither `wake` nor `onReceive` produced a log byte-identical to
// a healthy one: "Message received", then "hook completed" a few milliseconds later, for
// every message that in fact reached no one.

import test from "node:test";
import assert from "node:assert/strict";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";

const message = (msgId, cursor) => ({
  from: "agent-a",
  text: "hello",
  msgId,
  conversationId: "conv-1",
  ts: `2026-09-15T00:00:${String(cursor).padStart(2, "0")}.000Z`,
  cursor,
});

const recorder = () => {
  const lines = [];
  return { lines, log: (level, msg, fields) => lines.push({ level, msg, fields }) };
};

const linesNamed = (lines, msg) => lines.filter((line) => line.msg === msg);

test("WakeMonitor logs hook completed when a hook actually ran", async () => {
  const { lines, log } = recorder();
  const calls = [];
  const monitor = new WakeMonitor({
    hook: async (payload) => { calls.push(payload.msgId); },
    log,
    now: () => 1000,
  });

  await monitor.onInbound(message("msg-1", 1));

  assert.deepEqual(calls, ["msg-1"], "the hook must have been called");
  const completed = linesNamed(lines, "WakeMonitor hook completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].fields.msgId, "msg-1");
  assert.equal(completed[0].fields.conversationId, "conv-1");
  assert.equal(
    linesNamed(lines, "WakeMonitor: hook not configured, message stored only").length,
    0,
    "a wake that did happen must not be reported as a missing responder",
  );
});

test("WakeMonitor says the message was only stored when no hook is configured", async () => {
  const { lines, log } = recorder();
  const monitor = new WakeMonitor({ log, now: () => 1000 }); // no hook, no injector

  await monitor.onInbound(message("msg-2", 2));

  assert.equal(
    linesNamed(lines, "WakeMonitor hook completed").length,
    0,
    "a wake that never happened must not be logged as a completed hook",
  );
  const honest = linesNamed(lines, "WakeMonitor: hook not configured, message stored only");
  assert.equal(honest.length, 1);
  assert.equal(honest[0].level, "warn");
  assert.equal(honest[0].fields.msgId, "msg-2");
  assert.equal(honest[0].fields.conversationId, "conv-1");
  assert.equal(honest[0].fields.from, "agent-a");
});

test("responderStatus answers whether this monitor can wake anybody at all", () => {
  assert.deepEqual(
    new WakeMonitor({ hook: async () => {} }).responderStatus(),
    { configured: true, hook: true, native: false, nativePeers: [] },
  );

  assert.deepEqual(
    new WakeMonitor({}).responderStatus(),
    { configured: false, hook: false, native: false, nativePeers: [] },
    "no hook and no native peer is the zero-responder state the daemon must report",
  );

  assert.deepEqual(
    new WakeMonitor({
      peers: { "agent-a": { mode: "codex_app_server" } },
      injector: async () => ({}),
    }).responderStatus(),
    { configured: true, hook: false, native: true, nativePeers: ["agent-a"] },
  );

  // A native peer whose injector was never wired in is not a responder: it is an error
  // thrown on the first message. Counting it as configured would hide exactly the state
  // this field exists to expose.
  assert.equal(
    new WakeMonitor({ peers: { "agent-a": { mode: "codex_app_server" } } }).responderStatus().configured,
    false,
  );
});
