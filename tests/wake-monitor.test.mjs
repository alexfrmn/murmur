import test from "node:test";
import assert from "node:assert/strict";
import { createShellHook, WakeMonitor } from "../scripts/wake-monitor.mjs";

const message = (msgId, cursor, text = msgId) => ({
  from: "agent-a",
  text,
  msgId,
  conversationId: "conv-1",
  ts: `2026-06-20T00:00:${String(cursor).padStart(2, "0")}.000Z`,
  cursor,
});

test("WakeMonitor calls hook once for a new msgId", async () => {
  const calls = [];
  const monitor = new WakeMonitor({
    hook: async (payload) => calls.push(payload.msgId),
    now: () => 1000,
  });

  await monitor.onInbound(message("msg-1", 1));

  assert.deepEqual(calls, ["msg-1"]);
});

test("WakeMonitor drops duplicate msgId within cooldown window", async () => {
  const calls = [];
  let now = 1000;
  const monitor = new WakeMonitor({
    dedup: { cooldownMs: 300000 },
    hook: async (payload) => calls.push(payload.msgId),
    now: () => now,
  });

  await monitor.onInbound(message("msg-1", 1));
  now += 1000;
  await monitor.onInbound(message("msg-1", 2));

  assert.deepEqual(calls, ["msg-1"]);
});

test("WakeMonitor drains inbound backlog FIFO until idle", async () => {
  const calls = [];
  const backlog = [
    message("msg-2", 2),
    message("msg-3", 3),
  ];
  const monitor = new WakeMonitor({
    hook: async (payload) => calls.push(payload.msgId),
    loadBacklogAfter: async (cursor) => {
      const rows = backlog.filter((row) => row.cursor > cursor);
      backlog.length = 0;
      return rows;
    },
    now: () => 1000,
  });

  await monitor.onInbound(message("msg-1", 1));

  assert.deepEqual(calls, ["msg-1", "msg-2", "msg-3"]);
});

test("shell hooks receive structured Phase N routing metadata", async () => {
  const warnings = [];
  const hook = createShellHook({
    command: '[ "$MURMUR_CHANNEL_ID" = "channel-1" ] && [ "$MURMUR_SENDER_MEMBER_ID" = "topic:5935" ] && [ "$MURMUR_ADDRESSEE_MEMBER_ID" = "mac" ]',
    baseEnv: {},
    log: (...args) => warnings.push(args),
  });
  await hook({
    ...message("msg-routed", 4),
    channelId: "channel-1",
    senderMemberId: "topic:5935",
    addresseeMemberId: "mac",
  });
  assert.deepEqual(warnings, []);
});

test("receive-time ineligible backlog rows advance without invoking wake effects", async () => {
  const calls = [];
  const auditCalls = [];
  const leaseCalls = [];
  const notifications = [];
  let backlogReturned = false;
  const monitor = new WakeMonitor({
    hook: async (payload) => calls.push(payload.msgId),
    auditHook: async (payload) => {
      auditCalls.push(payload.msgId);
      return "allow";
    },
    leaseGate: async (payload) => {
      leaseCalls.push(payload.msgId);
      return { allow: true };
    },
    notify: async (payload, reason) => notifications.push({ msgId: payload.msgId, reason }),
    loadBacklogAfter: async () => {
      if (backlogReturned) return [];
      backlogReturned = true;
      return [
        { ...message("muted", 2), wakeEligible: false },
        { ...message("allowed", 3), wakeEligible: true },
      ];
    },
  });

  await monitor.onInbound({ ...message("trigger", 1), wakeEligible: true });

  assert.deepEqual(calls, ["trigger", "allowed"]);
  assert.deepEqual(auditCalls, ["trigger", "allowed"]);
  assert.deepEqual(leaseCalls, ["trigger", "allowed"]);
  assert.deepEqual(notifications, []);
  assert.equal(monitor.cursor, 3);
});

test("receive-time ineligible rows cannot reach the native injector", async () => {
  const calls = [];
  const monitor = new WakeMonitor({
    peers: {
      "agent-a": { mode: "codex_app_server" },
    },
    injector: async (payload) => calls.push(payload.msgId),
    auditHook: async () => {
      throw new Error("audit must not run");
    },
    leaseGate: async () => {
      throw new Error("lease gate must not run");
    },
    notify: async () => {
      throw new Error("notification must not run");
    },
  });

  await monitor.onInbound({ ...message("muted-native", 1), wakeEligible: false });

  assert.deepEqual(calls, []);
  assert.equal(monitor.cursor, 1);
});

test("missing wake eligibility preserves legacy backlog behavior", async () => {
  const calls = [];
  let backlogReturned = false;
  const monitor = new WakeMonitor({
    hook: async (payload) => calls.push(payload.msgId),
    loadBacklogAfter: async () => {
      if (backlogReturned) return [];
      backlogReturned = true;
      return [message("legacy", 2)];
    },
  });

  await monitor.onInbound(message("trigger", 1));
  assert.deepEqual(calls, ["trigger", "legacy"]);
});
