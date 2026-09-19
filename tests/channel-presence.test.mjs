import test from "node:test";
import assert from "node:assert/strict";
import { ChannelRosterStore } from "../packages/core/dist/src/index.js";

function fixture(t) {
  const store = new ChannelRosterStore(":memory:");
  t.after(() => store.close());
  store.createChannel({ channelId: "channel", conversationId: "history", type: "group", members: [
    { memberId: "self", agentId: "agent-a" }, { memberId: "peer", agentId: "agent-b" },
  ] });
  const input = { channelId: "channel", memberId: "self", agentId: "agent-a", sessionId: "session-1", ttlMs: 5000, now: 10000 };
  return { store, input };
}

test("two chat sessions have independent presence within one channel/member", (t) => {
  const { store, input } = fixture(t);
  store.heartbeatChannelSession(input);
  store.heartbeatChannelSession({ ...input, sessionId: "session-2", status: "busy" });
  const rows = store.listChannelPresence("channel", { now: 10001 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].conversationId, "history");
  assert.deepEqual(rows.map((r) => r.status), ["active", "busy"]);
  assert.equal(store.leaveChannelSession({ ...input, agentId: "agent-b" }), false);
  assert.equal(store.leaveChannelSession(input), true);
  assert.deepEqual(store.listChannelPresence("channel", { now: 10001 }).map((r) => r.sessionId), ["session-2"]);
});

test("heartbeat extends TTL; a crashed session disappears at the exact expiry boundary", (t) => {
  const { store, input } = fixture(t);
  const first = store.heartbeatChannelSession(input);
  const second = store.heartbeatChannelSession({ ...input, now: 12000, status: "idle" });
  assert.equal(second.joinedAt, first.joinedAt);
  assert.equal(second.heartbeatAt, 12000);
  assert.equal(store.listChannelPresence("channel", { now: 16999 }).length, 1);
  assert.deepEqual(store.listChannelPresence("channel", { now: 17000 }), []);
  assert.equal(store.heartbeatChannelSession({ ...input, now: 17000 }).joinedAt, 17000);
});

test("presence cannot grant membership or change addressing decisions", (t) => {
  const { store, input } = fixture(t);
  const routing = { channelId: "channel", selfAgentId: "agent-a", senderAgentId: "agent-b", senderMemberId: "peer", addresseeMemberId: "peer" };
  const before = store.evaluateAddressing(routing);
  assert.throws(() => store.heartbeatChannelSession({ ...input, memberId: "intruder" }), /presence-member/);
  assert.throws(() => store.heartbeatChannelSession({ ...input, agentId: "agent-b" }), /presence-member/);
  store.heartbeatChannelSession(input);
  assert.deepEqual(store.evaluateAddressing(routing), before);
  assert.equal(before.allowWake, false);
  assert.equal(store.listChannelMembers("channel").length, 2);
});

test("closed channels and departed/remapped members are absent immediately", (t) => {
  const { store, input } = fixture(t);
  store.heartbeatChannelSession(input);
  store.upsertChannelMember("channel", { memberId: "self", agentId: "agent-b" });
  assert.deepEqual(store.listChannelPresence("channel", { now: 10001 }), []);
  assert.throws(() => store.heartbeatChannelSession(input), /presence-member/);
  store.upsertChannelMember("channel", { memberId: "self", agentId: "agent-a", leftAt: "2026-09-19T00:00:00Z" });
  assert.throws(() => store.heartbeatChannelSession(input), /presence-member/);
  store.closeChannel("channel");
  assert.throws(() => store.heartbeatChannelSession(input), /presence-channel/);
  assert.deepEqual(store.listChannelPresence("channel", { now: 10001 }), []);
});

test("presence validates identities, state, clock and bounded TTL", (t) => {
  const { store, input } = fixture(t);
  for (const ttlMs of [0, 4999, 300001, NaN, Infinity, 5500.5]) assert.throws(() => store.heartbeatChannelSession({ ...input, ttlMs }), /presence-ttl/);
  for (const sessionId of ["", " ", "x".repeat(257)]) assert.throws(() => store.heartbeatChannelSession({ ...input, sessionId }), /presence-identity/);
  assert.throws(() => store.heartbeatChannelSession({ ...input, status: "owner" }), /presence-status/);
  assert.throws(() => store.heartbeatChannelSession({ ...input, now: NaN }), /presence-clock/);
});
