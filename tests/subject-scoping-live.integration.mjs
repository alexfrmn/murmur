import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import { SQLiteDedupeOutboxStore, channelSubjectRoutes, ChannelRosterStore, stableEnvelopePayload } from "../packages/core/dist/src/index.js";
import { createKeyPair, createSigningKeyPair, encryptPayload, signEnvelope } from "../packages/security/dist/src/index.js";
import { planSubjectMigration, prepareSubjectMigration, checkSubjectRollback } from "../scripts/subject-migration.mjs";

const until = async (predicate) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
  assert.fail("condition not reached within 5 seconds");
};

test("isolated NATS: additive consumer migration, mixed traffic, restart and rollback", { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-subject-live-"));
  const server = spawn("nats-server", ["-a", "127.0.0.1", "-p", "-1", "-js", "-sd", join(dir, "jetstream")], { stdio: ["ignore", "ignore", "pipe"] });
  const brokers = [], stores = [], subscriptions = [];
  t.after(async () => {
    for (const sub of subscriptions) await sub.unsubscribe();
    for (const b of brokers) await b.close();
    for (const s of stores) s.db.close();
    if (server.exitCode === null) { const exited = once(server, "exit"); server.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`isolated-nats-exited:${code}`)));
    server.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const port = output.match(/Listening for client connections on 127\.0\.0\.1:(\d+)/)?.[1];
      if (port) resolve(`nats://127.0.0.1:${port}`);
    });
  });
  const config = { url, jetstream: true, stream: "SCOPING_TEST", streamSubjects: ["msg.>", "ack.>"] };
  const broker = new NatsBroker(config); brokers.push(broker);
  await broker.connect();
  const dedupe = new SQLiteDedupeOutboxStore(join(dir, "receiver.db")); stores.push(dedupe);
  const calls = [];
  const onMessage = async (env) => { await delay(10); calls.push(env.msgId); };
  const input = { stream: "SCOPING_TEST", subject: "msg.receiver", consumerId: "receiver", channelIds: ["channel.1", "channel.2"] };
  const routes = channelSubjectRoutes(input.subject, input.consumerId, { enabled: true, channelIds: input.channelIds });
  const params = (route) => ({ ...route, consumerId: input.consumerId, dedupe, onMessage, emitDeliveryAcks: false });
  const envelope = (msgId, channelId) => ({ schemaVersion: "1.0", msgId, conversationId: "history", senderAgentId: "sender", recipients: ["receiver"], createdAt: new Date().toISOString(), payloadCiphertext: "eA==", payloadNonce: "nonce", signature: "sig", ...(channelId ? { channelId, senderMemberId: "sender-member" } : {}) });
  subscriptions.push(await broker.subscribeWithAck(params(routes[0])));
  await broker.publish(routes[0].subject, envelope("old-before"));
  await until(() => calls.length === 1);
  const before = await broker.jsm.consumers.info(input.stream, "receiver");
  const plan = await planSubjectMigration(broker.jsm, input);
  assert.deepEqual(plan.consumers.map((r) => r.exists), [true, false, false]);
  assert.equal((await broker.jsm.streams.info(input.stream)).state.consumer_count, 1, "plan did not mutate");
  await prepareSubjectMigration(broker.jsm, input);
  await prepareSubjectMigration(broker.jsm, input);
  assert.equal((await broker.jsm.streams.info(input.stream)).state.consumer_count, 3);
  assert.ok((await broker.jsm.consumers.info(input.stream, "receiver")).ack_floor.stream_seq >= before.ack_floor.stream_seq);
  // NATS itself rejects a second stream with overlapping account subjects.
  await assert.rejects(broker.jsm.streams.add({ name: "OVERLAP", subjects: [routes[1].subject] }), /overlap/i);
  // Prepared but not running: data persists, and rollback refuses to abandon it.
  await broker.publish(routes[1].subject, envelope("queued-during-migration", routes[1].channelId));
  assert.equal((await checkSubjectRollback(broker.jsm, input)).safeToDisableReceivers, false);
  subscriptions.push(await broker.subscribeWithAck(params(routes[1])));
  subscriptions.push(await broker.subscribeWithAck(params(routes[2])));
  await until(() => calls.includes("queued-during-migration"));
  const duplicate = envelope("both-routes", routes[1].channelId);
  await Promise.all([
    broker.publish(routes[0].subject, duplicate, undefined, "legacy-copy"),
    broker.publish(routes[1].subject, duplicate, undefined, "scoped-copy"),
  ]);
  await until(() => calls.includes("both-routes"));
  await until(async () => (await checkSubjectRollback(broker.jsm, input)).safeToDisableReceivers);
  assert.equal(calls.filter((id) => id === "both-routes").length, 1, "same letter executes once across consumers");
  // Wrong channel never executes and does not poison later delivery on the right route.
  const moved = envelope("wrong-then-correct", routes[1].channelId);
  await broker.publish(routes[2].subject, moved, undefined, "wrong-route");
  await until(async () => (await checkSubjectRollback(broker.jsm, input)).safeToDisableReceivers);
  assert.ok(!calls.includes(moved.msgId));
  await broker.publish(routes[1].subject, moved, undefined, "correct-route");
  await until(() => calls.includes(moved.msgId));
  // Restart a scoped consumer with messages waiting; reuse its durable and shared DB.
  for (const sub of subscriptions.splice(1)) await sub.unsubscribe();
  await broker.publish(routes[2].subject, envelope("during-restart", routes[2].channelId));
  const restarted = new NatsBroker(config); brokers.push(restarted);
  subscriptions.push(await restarted.subscribeWithAck(params(routes[2])));
  await until(() => calls.includes("during-restart"));
  await until(async () => (await checkSubjectRollback(broker.jsm, input)).safeToDisableReceivers);
  for (const sub of subscriptions.splice(1)) await sub.unsubscribe();
  // Rollback publisher to the original subject; original durable remains healthy.
  await broker.publish(routes[0].subject, envelope("after-rollback", routes[1].channelId));
  await until(() => calls.includes("after-rollback"));
  assert.equal(calls.length, 6);
  // Real MCP channel process: canonical structured signature + roster + session wake.
  const channelDir = join(dir, "mcp"); mkdirSync(channelDir, { mode: 0o700 });
  const receiverKeys = { encryption: await createKeyPair(), signing: await createSigningKeyPair() };
  const senderKeys = { encryption: await createKeyPair(), signing: await createSigningKeyPair() };
  const roster = new ChannelRosterStore(join(channelDir, "channel-roster.db"));
  roster.createChannel({ channelId: "channel.1", conversationId: "mcp-proof", type: "group", members: [
    { memberId: "receiver-member", agentId: "receiver" }, { memberId: "sender-member", agentId: "sender" },
  ] }); roster.close();
  writeFileSync(join(channelDir, "agent-config.json"), JSON.stringify({ agentId: "receiver", subject: "msg.receiver", natsUrl: url,
    keys: receiverKeys, peers: { sender: { encryption: { publicKey: senderKeys.encryption.publicKey }, signing: { publicKey: senderKeys.signing.publicKey } } },
    channelRoster: { enabled: true }, subjectScoping: { enabled: true, channelIds: ["channel.1"] },
  }), { mode: 0o600 });
  const channel = spawn(process.execPath, ["scripts/murmur-mcp-channel-server.mjs"], {
    env: { ...process.env, DATA_DIR: channelDir, MURMUR_STORE_PATH: join(channelDir, "murmur.db"), MURMUR_LEASE_DB: join(channelDir, "lease.db"),
      MURMUR_LEASE_MODULE_URL: new URL("../scripts/lease.mjs", import.meta.url).href, MURMUR_MCP_LOG_PATH: join(channelDir, "channel.log"),
      MURMUR_MCP_SESSION_ID: "scoping-proof", CODEX_THREAD_ID: "scoping-proof", MURMUR_CHANNEL_ROSTER_PATH: join(channelDir, "channel-roster.db") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => { if (channel.exitCode === null && channel.signalCode === null) { const exit = once(channel, "exit"); channel.kill(); await exit; } });
  let stderr = "", stdout = "";
  channel.stderr.on("data", (b) => { stderr += b; });
  channel.stdout.on("data", (b) => { stdout += b; });
  await until(() => stderr.includes("Murmur MCP channel server subscribed"));
  const encrypted = await encryptPayload("structured channel wake", receiverKeys.encryption.publicKey, senderKeys.encryption.privateKey);
  const signed = { ...envelope("mcp-addressed", "channel.1"), conversationId: "mcp-proof", addresseeMemberId: "receiver-member", payloadCiphertext: encrypted.ciphertext, payloadNonce: encrypted.nonce };
  signed.signature = await signEnvelope(stableEnvelopePayload(signed), senderKeys.signing.privateKey);
  await broker.publish(routes[1].subject, signed);
  await until(() => stdout.includes("mcp-addressed"));
  const observer = { ...signed, msgId: "mcp-observer", addresseeMemberId: "sender-member" };
  observer.signature = await signEnvelope(stableEnvelopePayload(observer), senderKeys.signing.privateKey);
  await broker.publish(routes[1].subject, observer);
  await until(() => stderr.includes("suppressed by addressing"));
  assert.ok(!stdout.includes("mcp-observer"));
  const channelExit = once(channel, "exit"); channel.kill(); await channelExit;
  console.log(JSON.stringify({ isolated: true, handlers: calls, consumers: 3, legacyCursorPreserved: true, rollback: "pass" }));
});
