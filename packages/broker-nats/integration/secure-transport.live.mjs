import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, StringCodec, AckPolicy, DeliverPolicy } from "nats";
import { join } from "node:path";
import { buildSecureNatsConnectionOptions, SQLiteDedupeOutboxStore, stableAckPayload } from "../../core/dist/src/index.js";
import { NatsBroker } from "../dist/src/index.js";
import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from "../../security/dist/src/index.js";
import { dashboardNatsOptions } from "../../../dashboard/nats-config.mjs";

const port = process.env.SECURE_NATS_PORT;
const caFile = process.env.SECURE_NATS_CA_FILE;
assert.ok(port && caFile, "secure NATS test environment is incomplete");

const url = `tls://127.0.0.1:${port}`;
const connectPeer = (user, password) => connect(buildSecureNatsConnectionOptions({
  url,
  user,
  password,
  tls: { caFile, serverName: "localhost" },
}));

const peerA = await connectPeer("agent-a", "test-password-a");
const peerB = await connectPeer("agent-b", "test-password-b");
const codec = StringCodec();
const runtime = [], stores = [];

try {
  const allowed = peerB.subscribe("msg.agent-b", { max: 1 });
  await peerB.flush();
  peerA.publish("msg.agent-b", codec.encode("allowed"));
  await peerA.flush();
  const received = await Promise.race([
    (async () => {
      for await (const message of allowed) return codec.decode(message.data);
      return undefined;
    })(),
    sleep(2_000).then(() => "timeout"),
  ]);
  assert.equal(received, "allowed", "allowed per-peer message was not delivered");

  const bootstrap = await connectPeer("bootstrap", "test-bootstrap");
  try {
    const jsm = await bootstrap.jetstreamManager();
    await jsm.streams.add({ name: "MURMUR", subjects: ["msg.>", "ack.>"] });
    for (const agent of ["agent-a", "agent-b"]) {
      for (const [consumer, subject] of [[agent, `msg.${agent}`], [`${agent}-ack`, `ack.${agent}`]]) {
        await jsm.consumers.add("MURMUR", { durable_name: consumer, name: consumer, filter_subject: subject, ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All, ack_wait: 30_000_000_000, max_deliver: 5 });
      }
    }
  } finally { await bootstrap.drain(); }
  const brokerConfig = (user, password) => ({ url, user, password, tls: { caFile, serverName: "localhost" }, jetstream: true,
    jetstreamProvisioning: "client", stream: "MURMUR", connectMaxAttempts: 1, waitOnFirstConnect: false });
  const sender = new NatsBroker(brokerConfig("agent-a", "test-password-a"));
  const receiver = new NatsBroker(brokerConfig("agent-b", "test-password-b"));
  runtime.push(sender, receiver);
  const outbox = new SQLiteDedupeOutboxStore(join(process.env.SECURE_NATS_STATE_DIR, "outbox.db"));
  const dedupe = new SQLiteDedupeOutboxStore(join(process.env.SECURE_NATS_STATE_DIR, "dedupe.db"));
  stores.push(outbox, dedupe);
  const signing = await createSigningKeyPair();
  let handlers = 0;
  await sender.startAckCorrelation({ outbox, ackReceipts: outbox, ackSubject: "ack.agent-a", consumerId: "agent-a-ack", requireSignedAcks: true,
    verifyAck: (ack) => verifyEnvelopeSignature(stableAckPayload(ack), ack.signature, signing.publicKey) });
  await receiver.subscribeWithAck({ subject: "msg.agent-b", consumerId: "agent-b", dedupe, onMessage: async () => { handlers++; },
    signAck: async (ack) => ({ ...ack, signature: await signEnvelope(stableAckPayload(ack), signing.privateKey) }) });
  const envelope = { schemaVersion: "1.0", msgId: "tls-durable-proof", conversationId: "tls-proof", senderAgentId: "agent-a", recipients: ["agent-b"],
    createdAt: new Date().toISOString(), payloadCiphertext: "eA==", payloadNonce: "nonce", signature: "sig" };
  await outbox.enqueue("msg.agent-b", envelope);
  await sender.flushOutbox({ outbox });
  for (let i = 0; i < 100 && (await outbox.getOutboxRecord(envelope.msgId)).status !== "acked"; i++) await sleep(20);
  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "acked", "restricted TLS peer completed durable ACK cycle");
  assert.equal(handlers, 1);

  // API subjects containing consumer names are allowed only for this peer's own durables.
  await assert.rejects(peerA.request("$JS.API.CONSUMER.INFO.MURMUR.agent-b", codec.encode("{}"), { timeout: 1000 }), /permission|timeout/i);
  await assert.rejects(peerA.request("$JS.API.STREAM.MSG.GET.MURMUR", codec.encode('{"seq":1}'), { timeout: 1000 }), /permission|timeout/i);
  await assert.rejects(peerA.request("$JS.API.CONSUMER.CREATE.MURMUR.steal", codec.encode('{}'), { timeout: 1000 }), /permission|timeout/i);

  const dashboard = await connect(dashboardNatsOptions({ NATS_URL: url, NATS_USER: "dashboard", NATS_PASSWORD: "test-dashboard", NATS_CA_FILE: caFile, NATS_SERVER_NAME: "localhost" }));
  try {
    const watch = dashboard.subscribe("msg.agent-b", { max: 1 }); await dashboard.flush();
    peerA.publish("msg.agent-b", codec.encode(JSON.stringify({ ...envelope, msgId: "dashboard-observation" }))); await peerA.flush();
    const observed = await Promise.race([(async () => { for await (const m of watch) return codec.decode(m.data); })(), sleep(1000).then(() => "timeout")]);
    assert.equal(JSON.parse(observed).msgId, "dashboard-observation");
    const forbidden = (async () => { for await (const e of dashboard.status()) if (e.type === "error") return e; })();
    dashboard.publish("msg.agent-a", codec.encode("forbidden"));
    await dashboard.flush();
    assert.ok(await Promise.race([forbidden, sleep(1000).then(() => undefined)]), "dashboard must not publish");
  } finally { await dashboard.drain(); }

  const deniedStatus = (async () => {
    for await (const event of peerA.status()) {
      if (event.type === "error" && String(event.data).includes("PERMISSIONS_VIOLATION")) {
        return event;
      }
    }
    return undefined;
  })();
  peerA.publish("msg.agent-a", codec.encode("denied"));
  await peerA.flush().catch(() => undefined);
  assert.ok(
    await Promise.race([deniedStatus, sleep(2_000).then(() => undefined)]),
    "forbidden publish did not produce a permission violation",
  );

  await assert.rejects(
    connect(buildSecureNatsConnectionOptions({
      url,
      token: "retired-shared-token",
      tls: { caFile, serverName: "localhost" },
    })),
    /authorization|authentication/i,
  );

  await assert.rejects(
    connect(buildSecureNatsConnectionOptions({
      url,
      user: "agent-a",
      password: "test-password-a",
      tls: { caFile, serverName: "wrong-host.example" },
    })),
    /certificate|hostname|IP/i,
  );

  await assert.rejects(connect(buildSecureNatsConnectionOptions({ url, user: "agent-a", password: "test-password-a", tls: { serverName: "localhost" } })), /certificate|self.signed/i);

  console.log("secure NATS TLS + restricted JetStream durable ACK + read-only dashboard ACL integration passed");
} finally {
  await Promise.allSettled(runtime.map((b) => b.close()));
  for (const store of stores) store.db.close();
  await Promise.allSettled([peerA.drain(), peerB.drain()]);
}
