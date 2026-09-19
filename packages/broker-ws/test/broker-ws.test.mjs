import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { InMemoryDedupeStore, stableAckPayload } from "../../core/dist/src/index.js";
import { WebSocketBroker, WebSocketRelay, wsSubjectMatches } from "../dist/src/index.js";

import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from "../../security/dist/src/index.js";
async function ackCrypto() {
  const keys = await createSigningKeyPair();
  return { signAck: async ack => ({...ack, signature:await signEnvelope(stableAckPayload(ack),keys.privateKey)}),
    verifyAck: ack => verifyEnvelopeSignature(stableAckPayload(ack),ack.signature,keys.publicKey) };
}
function envelope(overrides = {}) {
  return {
    schemaVersion: "1.0",
    msgId: "msg-1",
    conversationId: "conv-1",
    senderAgentId: "alice",
    recipients: ["bob"],
    createdAt: "2026-06-21T23:10:00.000Z",
    payloadCiphertext: "cipher",
    payloadNonce: "nonce",
    signature: "sig",
    ...overrides,
  };
}

async function eventually(fn, timeoutMs = 1500) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastErr;
}

async function withRelay(fn) {
  const relay = new WebSocketRelay({ host: "127.0.0.1", port: 0 });
  const { url } = await relay.listen();
  try {
    await fn(url);
  } finally {
    await relay.close();
  }
}

class MemoryOutbox {
  acked = [];
  failed = [];
  status = "sent";
  async getOutboxRecord(msgId) { return msgId === "msg-1" ? { envelope:envelope(), status:this.status } : undefined; }
  async applyAckTransition(msgId, status, reason) {
    if (this.status === "acked") return "ignored-terminal";
    if (status === "ack") { this.status="acked"; this.acked.push(msgId); }
    else this.failed.push({msgId,error:reason});
    return "applied";
  }

  async markAcked(msgId) {
    this.acked.push(msgId);
  }

  async markFailed(msgId, error) {
    this.failed.push({ msgId, error });
  }
}

test("wsSubjectMatches supports exact, star, and tail wildcards", () => {
  assert.equal(wsSubjectMatches("msg.bob", "msg.bob"), true);
  assert.equal(wsSubjectMatches("msg.*", "msg.bob"), true);
  assert.equal(wsSubjectMatches("msg.>", "msg.bob.one"), true);
  assert.equal(wsSubjectMatches("msg.*", "msg.bob.one"), false);
  assert.equal(wsSubjectMatches("ack.alice", "ack.bob"), false);
});

test("WebSocketBroker publishes envelopes through a relay and correlates ACKs", async () => {
  await withRelay(async (url) => {
    const alice = new WebSocketBroker({ url });
    const bob = new WebSocketBroker({ url });
    const seen = [];
    const outbox = new MemoryOutbox();

    const crypto = await ackCrypto();
    await alice.startAckCorrelation({ ackSubject: "ack.alice", outbox, verifyAck:crypto.verifyAck });
    await bob.subscribeWithAck({
      signAck:crypto.signAck,
      subject: "msg.bob",
      consumerId: "bob",
      dedupe: new InMemoryDedupeStore(),
      onMessage: async (msg) => {
        seen.push(msg.msgId);
      },
    });

    await alice.publish("msg.bob", envelope());

    await eventually(() => assert.deepEqual(seen, ["msg-1"]));
    await eventually(() => assert.deepEqual(outbox.acked, ["msg-1"]));

    await alice.close();
    await bob.close();
  });
});

test("WebSocketBroker dedupes delivery and emits a signed duplicate ACK without settling twice", async () => {
  await withRelay(async (url) => {
    const alice = new WebSocketBroker({ url });
    const bob = new WebSocketBroker({ url });
    const seen = [];
    const outbox = new MemoryOutbox();

    const crypto = await ackCrypto();
    await alice.startAckCorrelation({ ackSubject: "ack.alice", outbox, verifyAck:crypto.verifyAck });
    await bob.subscribeWithAck({
      signAck:crypto.signAck,
      subject: "msg.bob",
      consumerId: "bob",
      dedupe: new InMemoryDedupeStore(),
      onMessage: async (msg) => {
        seen.push(msg.msgId);
      },
    });

    const published = [], publishAck = bob.publishAck.bind(bob);
    bob.publishAck = async (subject, ack) => { published.push(ack); await publishAck(subject, ack); };
    await alice.publish("msg.bob", envelope());
    await alice.publish("msg.bob", envelope());

    await eventually(() => assert.deepEqual(seen, ["msg-1"]));
    await eventually(() => assert.equal(published.length, 2));
    assert.equal(published[1].reason, "duplicate-ignored");
    assert.equal(await crypto.verifyAck(published[1]), true);
    await eventually(() => assert.deepEqual(outbox.acked, ["msg-1"]));

    await alice.close();
    await bob.close();
  });
});

test("WebSocketBroker rejects unbound invalid-envelope NACKs without failing any outbox row", async () => {
  await withRelay(async (url) => {
    const alice = new WebSocketBroker({ url });
    const bob = new WebSocketBroker({ url });
    const outbox = new MemoryOutbox();

    const rejected = [];
    await alice.startAckCorrelation({ ackSubject: "ack.alice", outbox, onInvalidAck:e=>rejected.push(e.reason) });
    await bob.subscribeWithAck({
      subject: "msg.bob",
      consumerId: "bob",
      dedupe: new InMemoryDedupeStore(),
      onMessage: async () => {
        throw new Error("should-not-run");
      },
    });

    const raw = new WebSocket(url);
    await new Promise((resolve) => raw.once("open", resolve));
    raw.send(JSON.stringify({ type: "message", subject: "msg.bob", envelope: { msgId: "bad", senderAgentId: "alice" } }));

    await eventually(() => assert.deepEqual(rejected, ["unsigned-or-malformed"]));
    assert.deepEqual(outbox.failed, []);
    raw.close();
    await alice.close();
    await bob.close();
  });
});
