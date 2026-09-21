import test from "node:test";
import assert from "node:assert/strict";
import { buildNatsPeerPermissions, natsUserInboxPrefix } from "../packages/core/dist/src/index.js";
import { dashboardNatsOptions } from "../dashboard/nats-config.mjs";
import { startJetStreamAdvisoryDlqIfEnabled } from "../scripts/murmur-jetstream-advisory.mjs";

test("runtime JetStream role grants only own consumer APIs and segregated reply inbox", () => {
  const acl = buildNatsPeerPermissions({ user: "peer-a", agentId: "agent-a", peerIds: ["agent-b"] });
  assert.ok(acl.publish.includes("msg.agent-b"));
  assert.ok(acl.publish.includes("$JS.API.CONSUMER.MSG.NEXT.MURMUR.agent-a"));
  assert.ok(acl.publish.includes("$JS.ACK.MURMUR.agent-a.>"));
  assert.ok(acl.subscribe.includes(`${natsUserInboxPrefix("peer-a")}.>`));
  assert.ok(!acl.subscribe.includes("_INBOX.>"));
  for (const subject of acl.publish) assert.doesNotMatch(subject, /CREATE|DELETE|UPDATE|STREAM.MSG.GET|CONSUMER.INFO.MURMUR.agent-b/);
  assert.throws(() => buildNatsPeerPermissions({ user: "u", agentId: "a.*", peerIds: [] }), /token-invalid/);
  const domain = buildNatsPeerPermissions({ user: "u", agentId: "a", peerIds: [], jetstreamDomain: "sp", consumers: ["a-channel"] });
  assert.ok(domain.publish.includes("$JS.sp.API.CONSUMER.MSG.NEXT.MURMUR.a-channel"));
  assert.ok(domain.publish.includes("$JS.ACK.sp.*.MURMUR.a-channel.>"));
});

test("dashboard uses TLS builder and a separate explicit credential role", () => {
  const options = dashboardNatsOptions({ NATS_URL: "tls://broker.example:4222", NATS_USER: "dashboard", NATS_PASSWORD: "test", NATS_CA_FILE: "/ca.pem" });
  assert.equal(options.user, "dashboard");
  assert.deepEqual(options.tls, { caFile: "/ca.pem" });
  assert.throws(() => dashboardNatsOptions({ NATS_URL: "nats://remote.example:4222" }), /plaintext/);
});

test("restricted runtime can disable advisory stream reads explicitly", async () => {
  const result = await startJetStreamAdvisoryDlqIfEnabled({ broker: { startJetStreamAdvisoryDlq: () => assert.fail("must not request stream-wide reads") }, jetstreamEnabled: true, advisoryDlqEnabled: false });
  assert.equal(result, undefined);
});
