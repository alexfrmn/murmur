import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDaemonObservation } from "../scripts/daemon-observation.mjs";
import { createLinkWatch } from "../scripts/daemon-link-watch.mjs";

const fixture = async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "murmur-link-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const storePath = path.join(dataDir, "murmur.db");
  await fs.writeFile(storePath, "");
  const logs = [];
  const observation = createDaemonObservation({ dataDir, storePath, agentId: "agent-test", log: (level, message, data) => logs.push({ level, message, data }),
    wake: { enabled: false, mode: "none", responder: "none" } });
  const read = async () => { await observation.onStatus({ type: "noop" }); return JSON.parse(await fs.readFile(path.join(dataDir, "daemon-observation.json"), "utf8")); };
  return { dataDir, observation, logs, read };
};

test("the observation records when the link was lost and how many attempts failed", async (t) => {
  const f = await fixture(t);
  await f.observation.connected();
  let row = await f.read();
  assert.equal(row.broker.state, "connected"); assert.equal(row.broker.disconnectedAt, null); assert.equal(row.broker.reconnectAttempts, 0);
  assert.equal(f.observation.disconnectedForMs(), 0);

  await f.observation.onStatus({ type: "disconnect", data: "broker.example:4222", reconnects: 0 });
  row = await f.read();
  assert.equal(row.broker.state, "disconnected"); assert.equal(row.broker.lastError, "broker.disconnected");
  assert.ok(row.broker.disconnectedAt);
  const lostAt = row.broker.disconnectedAt;

  await f.observation.onStatus({ type: "reconnecting", data: { attempts: 7, disconnectedAt: lostAt, disconnectedForMs: 14_000 }, reconnects: 0 });
  row = await f.read();
  assert.equal(row.broker.reconnectAttempts, 7); assert.equal(row.broker.lastError, "broker.reconnecting");
  assert.equal(row.broker.disconnectedAt, lostAt, "the first loss instant is kept across attempts");
  assert.ok(f.observation.disconnectedForMs(Date.parse(lostAt) + 90_000) >= 90_000);

  await f.observation.onStatus({ type: "error", data: { reason: "broker.unauthorized" }, reconnects: 0 });
  row = await f.read();
  assert.equal(row.broker.state, "unauthorized"); assert.equal(row.broker.lastError, "broker.unauthorized");

  await f.observation.onStatus({ type: "error", data: { reason: "not a known reason: nats://x:y@z" }, reconnects: 0 });
  assert.equal((await f.read()).broker.lastError, "broker.connection-failed", "unknown text never reaches the file");

  await f.observation.onStatus({ type: "reconnect", data: "broker.example:4222", reconnects: 1 });
  row = await f.read();
  assert.equal(row.broker.state, "connected"); assert.equal(row.broker.disconnectedAt, null); assert.equal(row.broker.reconnectAttempts, 0);
  assert.equal(f.observation.disconnectedForMs(), 0);
  await f.observation.stop();
});

test("a closed connection is a closed state with an error line", async (t) => {
  const f = await fixture(t);
  await f.observation.connected();
  await f.observation.onStatus({ type: "closed", data: { reason: "broker.unauthorized", attempts: 2 }, reconnects: 0 });
  const row = await f.read();
  assert.equal(row.broker.state, "closed"); assert.equal(row.broker.lastError, "broker.unauthorized"); assert.ok(row.broker.disconnectedAt);
  assert.ok(f.logs.some((l) => l.level === "error" && l.message.startsWith("Server connection closed for good") && l.data.reason === "broker.unauthorized"));
  await f.observation.stop();
});

test("a daemon that never reached the server counts the loss from its start", async (t) => {
  const f = await fixture(t);
  const row = await f.read();
  assert.equal(row.broker.state, "disconnected"); assert.equal(row.broker.disconnectedAt, row.startedAt);
  await f.observation.onStatus({ type: "connect_error", data: { reason: "broker.connection-refused" }, reconnects: 0 });
  assert.equal((await f.read()).broker.disconnectedAt, row.startedAt);
  assert.ok(f.observation.disconnectedForMs(Date.parse(row.startedAt) + 5_000) >= 5_000);
  await f.observation.stop();
});

test("the link watch exits on a closed link by default and on a lost link only when asked", async (t) => {
  const f = await fixture(t);
  await f.observation.connected();
  let now = Date.parse("2026-09-24T11:21:35.000Z");
  const lost = [];
  const logs = [];
  const log = (level, message, data) => logs.push({ level, message, data });

  const off = createLinkWatch({ observation: f.observation, maxDisconnectedMs: 0, exitOnClosed: false, log, onLost: (r) => lost.push(r), now: () => now });
  assert.equal(off.enabled, false);
  await f.observation.onStatus({ type: "closed", data: { reason: "broker.unauthorized" }, reconnects: 0 });
  assert.equal(off.check(), false, "everything off: never fires");

  const closedOnly = createLinkWatch({ observation: f.observation, log, onLost: (r) => lost.push(r), now: () => now });
  assert.equal(closedOnly.enabled, true); assert.equal(closedOnly.maxDisconnectedMs, 0);
  assert.equal(closedOnly.check(), true);
  assert.deepEqual(lost, ["broker.link-closed"]);
  assert.equal(closedOnly.check(), true, "fires once");
  assert.equal(lost.length, 1);
  assert.equal(logs.at(-1).level, "fatal"); assert.equal(logs.at(-1).data.reason, "broker.link-closed"); assert.equal(logs.at(-1).data.lastError, "broker.unauthorized");

  await f.observation.onStatus({ type: "reconnect", reconnects: 1 });
  const bounded = createLinkWatch({ observation: f.observation, maxDisconnectedMs: 60_000, exitOnClosed: false, log, onLost: (r) => lost.push(r), now: () => now });
  assert.equal(bounded.intervalMs, 15_000, "checks every quarter of the limit");
  assert.equal(bounded.check(), false, "connected: nothing to do");
  await f.observation.onStatus({ type: "disconnect", reconnects: 1 });
  const lostAt = Date.parse(f.observation.broker().disconnectedAt);
  now = lostAt + 59_000;
  assert.equal(bounded.check(), false, "within the limit");
  now = lostAt + 61_000;
  assert.equal(bounded.check(), true);
  assert.deepEqual(lost, ["broker.link-closed", "broker.link-lost"]);
  assert.equal(logs.at(-1).data.maxDisconnectedMs, 60_000); assert.ok(logs.at(-1).data.disconnectedForMs > 60_000);

  const clamped = createLinkWatch({ observation: f.observation, maxDisconnectedMs: 1_000_000, exitOnClosed: true, onLost: () => {} });
  assert.equal(clamped.intervalMs, 30_000);
  const tiny = createLinkWatch({ observation: f.observation, maxDisconnectedMs: 500, exitOnClosed: true, onLost: () => {} });
  assert.equal(tiny.intervalMs, 1_000);
  const nonsense = createLinkWatch({ observation: f.observation, maxDisconnectedMs: Number.NaN, exitOnClosed: true, onLost: () => {} });
  assert.equal(nonsense.maxDisconnectedMs, 0); assert.equal(nonsense.enabled, true);
  await f.observation.stop();
});
