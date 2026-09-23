import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReplyMatcher,
  createReplySignalTap,
  requestDelivery,
  requestTiming,
  waitForReply,
} from "../packages/mcp-server/dist/src/request-reply.js";
import {
  codexTaskConversationId,
  defaultPeerConversationId,
} from "../packages/mcp-server/dist/src/codex-routing.js";

test("Codex task ids become exact-task conversation ids", () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  assert.equal(codexTaskConversationId(threadId), `codex:task:${threadId}`);
  assert.equal(defaultPeerConversationId({
    to: "agent-b",
    agentId: "agent-a",
    codexThreadId: threadId,
  }), `codex:task:${threadId}`);
});

test("non-Codex callers preserve the legacy peer conversation default", () => {
  assert.equal(defaultPeerConversationId({
    to: "agent-b",
    agentId: "agent-a",
    codexThreadId: "not-a-thread-id",
  }), "dm:agent-a:agent-b");
});

const reply = (msgId) => ({
  id: msgId,
  conversationId: "conv-1",
  msgId,
  direction: "inbound",
  sender: "agent.b",
  text: "pong",
  createdAt: new Date().toISOString(),
  transport: "nats",
});

// --- buildReplyMatcher -------------------------------------------------------

test("buildReplyMatcher matches same conversation + peer, rejects others", () => {
  const match = buildReplyMatcher("conv-1", "agent.b");
  assert.equal(match({ conversationId: "conv-1", senderAgentId: "agent.b" }), true);
  assert.equal(match({ conversationId: "conv-1", senderAgentId: "agent.c" }), false);
  assert.equal(match({ conversationId: "conv-2", senderAgentId: "agent.b" }), false);
});

test("buildReplyMatcher can distinguish members sharing one transport agent", () => {
  const match = buildReplyMatcher("conv-1", "agent.b", "topic:5935");
  assert.equal(match({ conversationId: "conv-1", senderAgentId: "agent.b", senderMemberId: "topic:5935" }), true);
  assert.equal(match({ conversationId: "conv-1", senderAgentId: "agent.b", senderMemberId: "topic:33" }), false);
  assert.equal(match({ conversationId: "conv-1", senderAgentId: "agent.b" }), false);
});

// --- A: durability when live-wait is OFF (pure store polling, no signal) ------

test("A: resolves via store-poll fallback when no wake signal is wired", async () => {
  let calls = 0;
  const res = await waitForReply({
    checkStore: async () => (++calls >= 2 ? reply("r-poll") : null),
    pollMs: 20,
    graceMs: 5,
    deadline: Date.now() + 2000,
    // onSignal intentionally omitted — proves durability without NATS
  });
  assert.equal(res?.msgId, "r-poll");
  assert.ok(calls >= 2, `expected >=2 store checks, got ${calls}`);
});

// --- B: timeout returns null (caller returns a normal awaiting_reply result) --

test("B: returns null on timeout when no reply ever lands", async () => {
  let calls = 0;
  const res = await waitForReply({
    checkStore: async () => {
      calls++;
      return null;
    },
    pollMs: 20,
    graceMs: 5,
    deadline: Date.now() + 120,
  });
  assert.equal(res, null);
  assert.ok(calls >= 2, `expected several poll attempts, got ${calls}`);
});

// --- C: wake signal accelerates the wait past a long poll interval ------------

test("C: a wake signal resolves the reply faster than the poll interval", async () => {
  let calls = 0;
  let fired = false;
  const start = Date.now();
  const res = await waitForReply({
    checkStore: async () => (++calls >= 2 ? reply("r-signal") : null),
    pollMs: 10_000, // a pure poll would never re-check within the deadline
    graceMs: 5,
    deadline: Date.now() + 1000,
    onSignal: (wake) => {
      setTimeout(() => {
        fired = true;
        wake();
      }, 30);
    },
  });
  const elapsed = Date.now() - start;
  assert.equal(res?.msgId, "r-signal");
  assert.ok(fired, "wake signal should have fired");
  assert.ok(elapsed < 500, `signal path should resolve fast, took ${elapsed}ms`);
});

test("C2: without a signal the same long-poll setup times out", async () => {
  // Mirror of C but with no wake signal. Uses the injectable clock/sleep so the
  // result is deterministic: with real timers, sleep(remaining) can undershoot the
  // deadline by a hair, letting the loop re-check the store right at the boundary and
  // return reply("never") — that re-check is harmless in production but made this test
  // flaky (`tests/mcp-request-reply.test.mjs:84`). A fake clock that advances exactly
  // by each requested sleep consumes the whole deadline in one wait, so the long poll
  // never re-checks before timing out.
  let calls = 0;
  let clock = 0;
  const res = await waitForReply({
    checkStore: async () => (++calls >= 2 ? reply("never") : null),
    pollMs: 10_000, // a pure poll would never re-check within the deadline
    graceMs: 5,
    deadline: 150, // shorter than poll interval → only the initial check fits
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(res, null);
  assert.equal(calls, 1); // only the initial check; no signal → no early re-poll
});

// --- D: lost-wakeup safety (signal fires DURING the store check) --------------

test("D: signal fired during checkStore is not lost (armed before check)", async () => {
  let calls = 0;
  let wakeCb = null;
  const res = await waitForReply({
    checkStore: async () => {
      calls++;
      if (calls === 1 && wakeCb) wakeCb(); // fire after arm, before the race
      return calls >= 2 ? reply("r-lostwake") : null;
    },
    pollMs: 10_000,
    graceMs: 5,
    deadline: Date.now() + 1000,
    onSignal: (wake) => {
      wakeCb = wake;
    },
  });
  assert.equal(res?.msgId, "r-lostwake");
  assert.equal(calls, 2);
});

test("request wait stays below desktop limits and rejects invalid timers before sending", async () => {
  const timing = requestTiming({timeout_ms:600_000,poll_interval_ms:600_000,grace_ms:90_000});
  assert.deepEqual(timing,{requestedTimeoutMs:600_000,timeoutMs:45_000,pollMs:45_000,graceMs:45_000});
  assert.equal(requestTiming({}).timeoutMs,45_000);
  assert.equal(requestTiming({timeout_ms:100}).timeoutMs,100);
  for (const invalid of [0,-1,NaN,Infinity,1.5,'600000']) assert.throws(()=>requestTiming({timeout_ms:invalid}),/timeout_ms/);
  assert.throws(()=>requestTiming({poll_interval_ms:0}),/poll_interval_ms/);
  assert.throws(()=>requestTiming({grace_ms:-1}),/grace_ms/);
  let now = 0;
  await waitForReply({checkStore:async()=>null,pollMs:timing.pollMs,graceMs:timing.graceMs,
    deadline:timing.timeoutMs,now:()=>now,sleep:async ms=>{now+=ms;}});
  assert.equal(now,45_000);
});

test("only an ACK is reported as delivered; retries and terminal DLQ remain distinct",()=>{
  assert.deepEqual(requestDelivery('acked'),{status:'delivered',acknowledged:true,outboxStatus:'acked'});
  for(const state of ['pending','sent','failed']) assert.deepEqual(requestDelivery(state),{status:'pending',acknowledged:false,outboxStatus:state});
  assert.deepEqual(requestDelivery('dlq'),{status:'failed',acknowledged:false,outboxStatus:'dlq'});
  assert.deepEqual(requestDelivery(undefined),{status:'unknown',acknowledged:false,outboxStatus:'unknown'});
});

const tick = ()=>new Promise(resolve=>setImmediate(resolve));
test("optional tap connecting forever cannot block store polling or cleanup",async()=>{
  let clock=0,tap;
  const result=await waitForReply({checkStore:async()=>null,pollMs:100,graceMs:0,deadline:100,
    now:()=>clock,sleep:async ms=>{clock+=ms;},
    onSignal:wake=>{tap=createReplySignalTap(()=>new Promise(()=>{}),['msg.a'],wake);}});
  tap.close();assert.equal(result,null);assert.equal(clock,100);assert.equal(tap.hasAttached(),false);
});

test("tap releases a subscription that finishes attaching after the request completes",async()=>{
  let finishSubscribe,unsubscribed=0,delivered=0,callback;
  const broker={subscribeRaw:async(subject,onEnvelope)=>{callback=onEnvelope;return new Promise(resolve=>{finishSubscribe=resolve;});}};
  const tap=createReplySignalTap(async()=>broker,['msg.a'],()=>{delivered++;});
  await tick();tap.close();finishSubscribe({unsubscribe:()=>{unsubscribed++;}});await tick();
  callback({});assert.equal(unsubscribed,1);assert.equal(delivered,0);assert.equal(tap.hasAttached(),false);
});

test("tap detaches active subscriptions without waiting on optional cleanup",async()=>{
  let unsubscribed=0;
  const tap=createReplySignalTap(async()=>({subscribeRaw:async()=>({unsubscribe:()=>{unsubscribed++;return new Promise(()=>{});}})}),['msg.a'],()=>{});
  await tick();assert.equal(tap.hasAttached(),true);tap.close();tap.close();assert.equal(unsubscribed,1);
});
