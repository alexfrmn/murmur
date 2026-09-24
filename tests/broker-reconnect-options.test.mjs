import test from "node:test";
import assert from "node:assert/strict";
import { buildNatsConnectionOptions, NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import { createServer } from 'node:net';

test("buildNatsConnectionOptions enables resilient reconnect defaults", () => {
  const options = buildNatsConnectionOptions({
    url: "nats://example.invalid:4222",
    token: "secret",
  });

  assert.equal(options.servers, "nats://example.invalid:4222");
  assert.equal(options.token, "secret");
  assert.equal(options.maxReconnectAttempts, -1);
  assert.equal(options.reconnectTimeWait, 2000);
  assert.equal(options.reconnectJitter, 500);
  assert.equal(options.pingInterval, 20000);
  assert.equal(options.maxPingOut, 2);
  assert.equal(options.waitOnFirstConnect, true);
});
test('initial refused connection reports a safe reason before connect rejects', async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const events = [];
  const broker = new NatsBroker({ url: `nats://127.0.0.1:${port}`, waitOnFirstConnect: false,
    connectMaxAttempts: 1, connectTimeoutMs: 100, onStatus: event => events.push(event) });
  try {
    await assert.rejects(broker.connect());
    assert.equal(events[0]?.type, 'connect_error');
    assert.deepEqual(events[0]?.data, { reason: 'broker.connection-refused' });
  } finally { await broker.close(); }
});

test("buildNatsConnectionOptions allows bounded operator overrides", () => {
  const options = buildNatsConnectionOptions({
    url: "nats://example.invalid:4222",
    maxReconnectAttempts: 10,
    reconnectTimeWait: 5000,
    reconnectJitter: 1000,
    pingInterval: 30000,
    maxPingOut: 3,
    waitOnFirstConnect: false,
    connectTimeoutMs: 2000,
  });

  assert.equal(options.maxReconnectAttempts, 10);
  assert.equal(options.reconnectTimeWait, 5000);
  assert.equal(options.reconnectJitter, 1000);
  assert.equal(options.pingInterval, 30000);
  assert.equal(options.maxPingOut, 3);
  assert.equal(options.waitOnFirstConnect, false);
  assert.equal(options.timeout, 2000);
});
