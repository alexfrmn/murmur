import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";

// #105 — WakeMonitor over a durable delivery store. The two crash windows named by
// @alexanderyswork in #96/#105, plus what falls out of them: a cursor that never skips a
// gap, a restart that resumes from the table rather than its tip, and a message that keeps
// failing ending up somewhere visible instead of nowhere.

const T0 = Date.parse("2026-09-12T12:00:00.000Z");

const withStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-wake-delivery-"));
  const store = new SQLiteMessageStore(join(dir, "murmur.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const receive = async (store, msgId) => {
  const row = await store.append({
    conversationId: "conv-1",
    msgId,
    direction: "inbound",
    sender: "agent-peer",
    text: `text ${msgId}`,
    createdAt: new Date(T0).toISOString(),
    transport: "nats",
    wakeEligible: true,
  });
  return { from: row.sender, text: row.text, msgId: row.msgId, conversationId: row.conversationId, wakeEligible: true, cursor: row.rowid };
};

const monitorOver = (store, options = {}) => {
  const clock = { now: T0 };
  const monitor = new WakeMonitor({
    deliveries: store,
    retryBackoffMs: 1000,
    now: () => clock.now,
    ...options,
  });
  return { monitor, clock };
};

test("crash window 'relay failed': the cursor stays put and the same delivery is retried, not a new one", async () => {
  const { store, cleanup } = withStore();
  try {
    const calls = [];
    let failFirst = true;
    const { monitor, clock } = monitorOver(store, {
      hook: async (payload) => {
        calls.push({ msgId: payload.msgId, attempt: payload.attempt });
        if (failFirst) {
          failFirst = false;
          throw new Error("codex-app-server-turn-completion-timeout");
        }
      },
    });

    await monitor.onInbound(await receive(store, "m1"));
    assert.equal(calls.length, 1);
    assert.equal(monitor.cursor, 0, "a failed wake must not advance the cursor");
    assert.equal((await store.wakeStateFor("m1")).status, "failed");

    clock.now += 500;
    await monitor.drain();
    assert.equal(calls.length, 1, "not due yet — no retry before the backoff elapses");

    clock.now += 1000;
    await monitor.drain();
    assert.deepEqual(calls, [{ msgId: "m1", attempt: 1 }, { msgId: "m1", attempt: 2 }]);
    assert.equal(monitor.cursor, 1);
    assert.equal((await store.wakeStateFor("m1")).status, "handled");
  } finally {
    cleanup();
  }
});

test("crash window 'receiver committed, ACK lost': the redelivered copy does not wake twice", async () => {
  const { store, cleanup } = withStore();
  try {
    const calls = [];
    const { monitor, clock } = monitorOver(store, { hook: async (payload) => calls.push(payload.msgId) });

    const payload = await receive(store, "m1");
    await monitor.onInbound(payload);
    assert.deepEqual(calls, ["m1"]);

    // The sender never saw the ACK and sends the same envelope again — well outside the
    // in-memory cooldown, so only the durable state can stop the second wake.
    clock.now += 10 * 60 * 1000;
    const again = await store.append({
      conversationId: "conv-1",
      msgId: "m1",
      direction: "inbound",
      sender: "agent-peer",
      text: "text m1",
      createdAt: new Date(T0).toISOString(),
      transport: "nats",
      wakeEligible: true,
    });
    assert.equal(again.duplicate, true);
    await monitor.onInbound({ ...payload, cursor: again.rowid });

    assert.deepEqual(calls, ["m1"]);
    assert.equal(monitor.cursor, 1);
  } finally {
    cleanup();
  }
});

test("the cursor never skips a gap: a later success does not move it past an earlier failure", async () => {
  const { store, cleanup } = withStore();
  try {
    const failing = new Set(["m2"]);
    const calls = [];
    const { monitor, clock } = monitorOver(store, {
      hook: async (payload) => {
        calls.push(payload.msgId);
        if (failing.has(payload.msgId)) throw new Error("boom");
      },
    });

    await monitor.onInbound(await receive(store, "m1"));
    await monitor.onInbound(await receive(store, "m2"));
    await monitor.onInbound(await receive(store, "m3"));
    assert.deepEqual(calls, ["m1", "m2", "m3"]);
    assert.equal(monitor.cursor, 1, "m3 succeeded, but m2 is still open");

    failing.clear();
    clock.now += 1500;
    await monitor.drain();
    assert.deepEqual(calls, ["m1", "m2", "m3", "m2"]);
    assert.equal(monitor.cursor, 3);
  } finally {
    cleanup();
  }
});

test("a restart resumes from durable state, not from the table tip", async () => {
  const { store, cleanup } = withStore();
  try {
    const first = new WakeMonitor({
      deliveries: store,
      retryBackoffMs: 1000,
      now: () => T0,
      hook: async () => { throw new Error("crashed mid-wake"); },
    });
    await first.onInbound(await receive(store, "m1"));
    assert.equal((await store.wakeStateFor("m1")).status, "failed");

    // Old behaviour: a fresh monitor seeded its cursor at MAX(rowid) and m1 was gone for good.
    const calls = [];
    const clock = { now: T0 + 1500 };
    const second = new WakeMonitor({
      deliveries: store,
      retryBackoffMs: 1000,
      now: () => clock.now,
      hook: async (payload) => calls.push(payload.msgId),
    });
    await second.drain();

    assert.deepEqual(calls, ["m1"]);
    assert.equal(second.cursor, 1);
  } finally {
    cleanup();
  }
});

test("a delivery left in flight by a dead process is handed back to the queue on the next drain", async () => {
  const { store, cleanup } = withStore();
  try {
    const payload = await receive(store, "m1");
    await store.claimWake("m1"); // the process that claimed it is gone
    const calls = [];
    const { monitor } = monitorOver(store, { hook: async (p) => calls.push(p.msgId) });

    await monitor.drain();

    assert.deepEqual(calls, [payload.msgId]);
    assert.equal((await store.wakeStateFor("m1")).status, "handled");
  } finally {
    cleanup();
  }
});

test("a delivery that keeps failing is dead-lettered after maxAttempts and reported, never silently dropped", async () => {
  const { store, cleanup } = withStore();
  try {
    const notifications = [];
    const { monitor, clock } = monitorOver(store, {
      maxAttempts: 2,
      hook: async () => { throw new Error("always"); },
      notify: async (payload, reason) => notifications.push({ msgId: payload.msgId, reason }),
    });

    await monitor.onInbound(await receive(store, "m1"));
    assert.equal((await store.wakeStateFor("m1")).status, "failed");
    assert.deepEqual(notifications, []);

    clock.now += 1500;
    await monitor.drain();

    const state = await store.wakeStateFor("m1");
    assert.equal(state.status, "dlq");
    assert.equal(state.attempts, 2);
    assert.match(state.error, /always/);
    assert.deepEqual(notifications, [{ msgId: "m1", reason: "wake-dlq" }]);
    assert.equal(monitor.cursor, 1, "a dead-lettered delivery is settled: the cursor may pass it");
  } finally {
    cleanup();
  }
});

test("a wake error marked non-retryable is dead-lettered on the first attempt", async () => {
  const { store, cleanup } = withStore();
  try {
    const notifications = [];
    const { monitor } = monitorOver(store, {
      hook: async () => { throw Object.assign(new Error("codex-app-server-final-empty:turn-1"), { retryable: false }); },
      notify: async (payload, reason) => notifications.push({ msgId: payload.msgId, reason }),
    });

    await monitor.onInbound(await receive(store, "m1"));

    const state = await store.wakeStateFor("m1");
    assert.equal(state.status, "dlq");
    assert.equal(state.attempts, 1);
    assert.deepEqual(notifications, [{ msgId: "m1", reason: "wake-dlq" }]);
  } finally {
    cleanup();
  }
});

test("a policy decision settles the delivery as muted: no hook, no retry, cursor moves on", async () => {
  const { store, cleanup } = withStore();
  try {
    const calls = [];
    const { monitor } = monitorOver(store, {
      auditHook: async () => "deny",
      hook: async (payload) => calls.push(payload.msgId),
    });

    await monitor.onInbound(await receive(store, "m1"));

    assert.deepEqual(calls, []);
    assert.equal((await store.wakeStateFor("m1")).status, "muted");
    assert.equal(monitor.cursor, 1);
  } finally {
    cleanup();
  }
});

test("the reply id returned by the hook is recorded on the delivery", async () => {
  const { store, cleanup } = withStore();
  try {
    const { monitor } = monitorOver(store, { hook: async () => ({ replyMsgId: "reply-1" }) });

    await monitor.onInbound(await receive(store, "m1"));

    const state = await store.wakeStateFor("m1");
    assert.equal(state.status, "handled");
    assert.equal(state.replyMsgId, "reply-1");
  } finally {
    cleanup();
  }
});

test("a duplicate queued while the first copy is being processed is refused by the claim", async () => {
  const { store, cleanup } = withStore();
  try {
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { monitor } = monitorOver(store, {
      hook: async (payload) => {
        calls.push(payload.msgId);
        await gate;
      },
    });

    const payload = await receive(store, "m1");
    const firstRun = monitor.onInbound(payload);
    const secondRun = monitor.onInbound({ ...payload });
    release();
    await Promise.all([firstRun, secondRun]);
    await monitor.drain();

    assert.deepEqual(calls, ["m1"]);
    assert.equal((await store.wakeStateFor("m1")).status, "handled");
  } finally {
    cleanup();
  }
});

test("normalizeWakeConfig carries the retry policy through", async () => {
  const { normalizeWakeConfig } = await import("../scripts/wake-monitor.mjs");
  const config = normalizeWakeConfig({ wake: { retry: { maxAttempts: 3, backoffMs: 5000, backoffMaxMs: 60000 } } });
  assert.deepEqual(config.retry, { maxAttempts: 3, backoffMs: 5000, backoffMaxMs: 60000 });
  assert.deepEqual(normalizeWakeConfig({}).retry, { maxAttempts: 5, backoffMs: 30000, backoffMaxMs: 600000 });
});
