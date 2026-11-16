import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdvisoryDlqEnabled, startJetStreamAdvisoryDlqIfEnabled } from "../scripts/murmur-jetstream-advisory.mjs";

test("startJetStreamAdvisoryDlqIfEnabled is dormant when JetStream is disabled", async () => {
  let calls = 0;
  const result = await startJetStreamAdvisoryDlqIfEnabled({
    jetstreamEnabled: false,
    outbox: {},
    broker: {
      async startJetStreamAdvisoryDlq() {
        calls += 1;
      },
    },
  });

  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("startJetStreamAdvisoryDlqIfEnabled wires advisory DLQ when JetStream is enabled", async () => {
  const outbox = {};
  const subscription = { unsubscribe() {} };
  const logs = [];
  const calls = [];

  const result = await startJetStreamAdvisoryDlqIfEnabled({
    jetstreamEnabled: true,
    outbox,
    log: (level, msg) => logs.push({ level, msg }),
    broker: {
      async startJetStreamAdvisoryDlq(params) {
        calls.push(params);
        return subscription;
      },
    },
  });

  assert.equal(result, subscription);
  assert.deepEqual(calls, [{ outbox }]);
  assert.deepEqual(logs, [{ level: "info", msg: "JetStream advisory DLQ correlation started" }]);
});

function fakeBroker(calls) {
  return {
    async startJetStreamAdvisoryDlq(params) {
      calls.push(params);
      return { unsubscribe() {} };
    },
  };
}

test("client provisioning keeps advisory DLQ off unless enabled explicitly", async () => {
  const calls = [];
  const logs = [];
  const result = await startJetStreamAdvisoryDlqIfEnabled({
    jetstreamEnabled: true,
    provisioning: "client",
    outbox: {},
    log: (level, msg) => logs.push({ level, msg }),
    broker: fakeBroker(calls),
  });
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
  assert.deepEqual(logs.map((l) => l.msg), ["JetStream advisory DLQ correlation disabled for client provisioning"]);

  const explicit = await startJetStreamAdvisoryDlqIfEnabled({
    jetstreamEnabled: true,
    provisioning: "client",
    advisoryDlq: true,
    outbox: {},
    broker: fakeBroker(calls),
  });
  assert.ok(explicit);
  assert.equal(calls.length, 1);
});

test("managed provisioning keeps the previous default; advisoryDlq false still disables it", async () => {
  const calls = [];
  assert.ok(await startJetStreamAdvisoryDlqIfEnabled({ jetstreamEnabled: true, provisioning: "managed", outbox: {}, broker: fakeBroker(calls) }));
  assert.equal(
    await startJetStreamAdvisoryDlqIfEnabled({ jetstreamEnabled: true, advisoryDlq: false, outbox: {}, broker: fakeBroker(calls) }),
    undefined,
  );
  assert.equal(calls.length, 1);
});

test("resolveAdvisoryDlqEnabled decision table", () => {
  assert.deepEqual(resolveAdvisoryDlqEnabled({}), { enabled: true, reason: "default" });
  assert.deepEqual(resolveAdvisoryDlqEnabled({ provisioning: "client" }), { enabled: false, reason: "client-provisioning" });
  assert.deepEqual(resolveAdvisoryDlqEnabled({ provisioning: "client", advisoryDlq: true }), { enabled: true, reason: "explicit" });
  assert.deepEqual(resolveAdvisoryDlqEnabled({ advisoryDlq: false }), { enabled: false, reason: "explicit" });
});
