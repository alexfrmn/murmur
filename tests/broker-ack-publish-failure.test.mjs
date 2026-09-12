import test from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";

const sc = StringCodec();

const envelope = {
  schemaVersion: "1.0",
  msgId: "msg-ackfail-1",
  conversationId: "conv-1",
  senderAgentId: "agent-sender",
  recipients: ["agent-receiver"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("x").toString("base64"),
  payloadNonce: "nonce",
  signature: "sig",
};

// Minimal JetStream fake: the ACK subject can be made to time out, and the delivered
// message reports a redelivery count so the nak backoff can be observed.
const makeBroker = ({ ackPublishFails = false, redeliveryCount = 1 } = {}) => {
  const published = [];
  const acked = [];
  const nacked = [];
  const fakeMessages = {
    async *[Symbol.asyncIterator]() {
      yield {
        data: sc.encode(JSON.stringify(envelope)),
        info: { redeliveryCount },
        ack() { acked.push(true); },
        nak(delay) { nacked.push(delay); },
      };
    },
    async close() {},
  };
  const fakeJsm = {
    streams: {
      async info() { return { config: { name: "MURMUR", subjects: ["msg.>", "ack.>"] } }; },
      async add() {},
      async update() {},
    },
    consumers: {
      async info() { throw new Error("consumer-missing"); },
      async add() {},
      async update() {},
    },
  };
  const fakeJs = {
    async publish(subject, data, opts) {
      if (ackPublishFails && subject.startsWith("ack.")) throw new Error("TIMEOUT");
      published.push({ subject, body: JSON.parse(sc.decode(data)), opts });
    },
    consumers: { async get() { return { async consume() { return fakeMessages; } }; } },
  };
  const broker = new NatsBroker({
    url: "nats://example.invalid",
    jetstream: true,
    stream: "MURMUR",
    streamSubjects: ["msg.>", "ack.>"],
  });
  broker.nc = {
    async jetstreamManager() { return fakeJsm; },
    jetstream() { return fakeJs; },
    subscribe() { return { async *[Symbol.asyncIterator]() {}, unsubscribe() {} }; },
    async drain() {},
  };
  return { broker, published, acked, nacked };
};

// Kirill's log, 11.09: the letter was stored and marked seen, then `js.publish` of the ACK
// timed out. That threw out of the handler path, the JetStream message was nak'd, came
// straight back, was rejected as a duplicate, the duplicate ACK timed out again — five
// rounds to max_deliver and a DLQ advisory for a message that had been delivered on the
// first pass. Delivery and acknowledgement are separate outcomes.
test("a delivered message stays delivered when publishing its ACK times out", async () => {
  const { broker, acked, nacked } = makeBroker({ ackPublishFails: true });
  let delivered = 0;
  const seen = [];
  const dedupe = {
    async seen() { return false; },
    async markSeen(msgId) { seen.push(msgId); },
  };

  await broker.subscribeWithAck({
    subject: "msg.agent-receiver",
    consumerId: "agent-receiver",
    dedupe,
    onMessage: async () => { delivered += 1; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(delivered, 1);
  assert.deepEqual(seen, [envelope.msgId]);
  assert.equal(acked.length, 1, "JetStream message acknowledged despite the ACK publish failure");
  assert.equal(nacked.length, 0);
});

test("a handler failure is nak'd with a backoff that grows with the redelivery count", async () => {
  const { broker, nacked } = makeBroker({ redeliveryCount: 3 });
  const dedupe = { async seen() { return false; }, async markSeen() {} };

  await broker.subscribeWithAck({
    subject: "msg.agent-receiver",
    consumerId: "agent-receiver",
    dedupe,
    maxPoisonAttempts: 99,
    onMessage: async () => { throw new Error("handler-down"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(nacked, [4000], "third delivery waits 1s * 2^(3-1)");
});

test("the nak backoff is capped so a poisoned letter never waits longer than 30s", async () => {
  const { broker, nacked } = makeBroker({ redeliveryCount: 12 });
  const dedupe = { async seen() { return false; }, async markSeen() {} };

  await broker.subscribeWithAck({
    subject: "msg.agent-receiver",
    consumerId: "agent-receiver",
    dedupe,
    maxPoisonAttempts: 99,
    onMessage: async () => { throw new Error("handler-down"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(nacked, [30000]);
});
