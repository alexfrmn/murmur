import test from "node:test";
import assert from "node:assert/strict";
import { brokerConnectionReason, createBrokerLinkTracker } from "../packages/broker-nats/dist/src/index.js";

const clock = (start = Date.parse("2026-09-24T11:21:35.000Z")) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

test("a lost link is remembered with its instant and every attempt is counted", () => {
  const c = clock();
  const tracker = createBrokerLinkTracker({ logIntervalMs: 60_000, now: c.now });
  assert.deepEqual(tracker.snapshot(), { state: "connected", disconnectedAt: null, reconnectAttempts: 0, lastReason: null, lastReasonAt: null });
  assert.equal(tracker.disconnectedForMs(), 0);

  const lost = tracker.handle({ type: "disconnect", data: "broker.example:4222" }, 0);
  assert.equal(lost.event.type, "disconnect");
  assert.equal(lost.log.level, "warn");
  assert.equal(lost.log.data.disconnectedAt, "2026-09-24T11:21:35.000Z");
  assert.equal("data" in lost.log.data, false, "the endpoint never reaches the log line");

  c.advance(2_000);
  const first = tracker.handle({ type: "reconnecting" }, 0);
  assert.deepEqual(first.event, { type: "reconnecting", reconnects: 0,
    data: { attempts: 1, disconnectedAt: "2026-09-24T11:21:35.000Z", disconnectedForMs: 2_000 } });
  assert.equal(first.log.message, "Server link still lost; reconnect attempts continue");

  for (let i = 0; i < 20; i += 1) { c.advance(2_000); assert.equal(tracker.handle({ type: "reconnecting" }, 0).log, undefined, "rate-limited"); }
  assert.equal(tracker.snapshot().reconnectAttempts, 21);
  assert.equal(tracker.disconnectedForMs(), 42_000);

  c.advance(20_000);
  const later = tracker.handle({ type: "reconnecting" }, 0);
  assert.equal(later.log.data.attempts, 22, "after the interval the next attempt is logged again");
  assert.equal(later.log.data.disconnectedForMs, 62_000);
});

test("a restored link resets the counters and reports how long it was gone", () => {
  const c = clock();
  const tracker = createBrokerLinkTracker({ now: c.now });
  tracker.handle({ type: "disconnect" }, 0);
  c.advance(5_000); tracker.handle({ type: "reconnecting" }, 0);
  c.advance(5_000);
  const back = tracker.handle({ type: "reconnect", data: "broker.example:4222" }, 1);
  assert.equal(back.event.type, "reconnect");
  assert.deepEqual(back.log.data, { reconnects: 1, attempts: 1, wasDisconnectedForMs: 10_000 });
  assert.deepEqual(tracker.snapshot(), { state: "connected", disconnectedAt: null, reconnectAttempts: 0, lastReason: null, lastReasonAt: null });
  assert.equal(tracker.disconnectedForMs(), 0);
});

test("reconnecting without a preceding disconnect still marks the loss", () => {
  const c = clock();
  const tracker = createBrokerLinkTracker({ now: c.now });
  const out = tracker.handle({ type: "reconnecting" }, 0);
  assert.equal(out.event.data.attempts, 1);
  assert.equal(tracker.snapshot().state, "disconnected");
  assert.equal(tracker.snapshot().disconnectedAt, "2026-09-24T11:21:35.000Z");
});

test("errors and stale connections carry a stable reason, never the error text", () => {
  const c = clock();
  const tracker = createBrokerLinkTracker({ logIntervalMs: 60_000, now: c.now });
  const auth = tracker.handle({ type: "error", data: Object.assign(new Error("Authorization Violation nats://user:token@host"), { code: "AUTHORIZATION_VIOLATION" }) }, 0);
  assert.deepEqual(auth.event, { type: "error", data: { reason: "broker.unauthorized" }, reconnects: 0 });
  assert.equal(auth.log.data.reason, "broker.unauthorized");
  assert.equal(JSON.stringify(auth).includes("token@host"), false);
  c.advance(1_000);
  assert.equal(tracker.handle({ type: "error", data: { code: "AUTHORIZATION_VIOLATION" } }, 0).log, undefined, "same reason is rate-limited");
  const perm = tracker.handle({ type: "error", data: { code: "PERMISSIONS_VIOLATION" } }, 0);
  assert.equal(perm.log.data.reason, "broker.permission-denied", "a different reason logs at once");
  const stale = tracker.handle({ type: "staleConnection" }, 0);
  assert.deepEqual(stale.event.data, { reason: "broker.stale-connection" });
  assert.equal(stale.log.level, "warn");
  assert.equal(tracker.snapshot().lastReason, "broker.stale-connection");
  assert.equal(tracker.snapshot().state, "connected", "an error alone does not mark the link lost");
});

test("routine debug statuses produce nothing", () => {
  const tracker = createBrokerLinkTracker();
  assert.deepEqual(tracker.handle({ type: "pingTimer" }, 0), {});
  assert.deepEqual(tracker.handle({ type: "client initiated reconnect" }, 0), {});
  const update = tracker.handle({ type: "update", data: { added: ["b"] } }, 0);
  assert.equal(update.event.type, "update");
  assert.equal(update.log.level, "info");
});

test("a connection closed for good is an error with the loss instant and the reason", () => {
  const c = clock();
  const tracker = createBrokerLinkTracker({ now: c.now });
  tracker.handle({ type: "disconnect" }, 0);
  c.advance(3_000); tracker.handle({ type: "reconnecting" }, 0);
  c.advance(3_000); tracker.handle({ type: "reconnecting" }, 0);
  const closed = tracker.closed({ code: "AUTHORIZATION_VIOLATION" }, 0);
  assert.deepEqual(closed.event, { type: "closed", reconnects: 0,
    data: { reason: "broker.unauthorized", disconnectedAt: "2026-09-24T11:21:35.000Z", attempts: 2 } });
  assert.equal(closed.log.level, "error");
  const plain = createBrokerLinkTracker({ now: c.now }).closed(undefined, 4);
  assert.equal(plain.event.data.reason, "broker.closed");
  assert.equal(plain.event.data.attempts, 0);
});

test("brokerConnectionReason maps client codes to stable reasons", () => {
  assert.equal(brokerConnectionReason({ code: "AUTHENTICATION_EXPIRED" }), "broker.unauthorized");
  assert.equal(brokerConnectionReason({ code: "ECONNREFUSED" }), "broker.connection-refused");
  assert.equal(brokerConnectionReason({ code: "ENOTFOUND" }), "broker.name-unresolved");
  assert.equal(brokerConnectionReason({ code: "TIMEOUT" }), "broker.timeout");
  assert.equal(brokerConnectionReason(new Error("anything")), "broker.connection-failed");
  assert.equal(brokerConnectionReason(undefined), "broker.connection-failed");
});
