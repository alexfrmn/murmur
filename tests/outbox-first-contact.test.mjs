import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringCodec } from 'nats';
import { SQLiteDedupeOutboxStore, createBoundAck, stableAckPayload } from '../packages/core/dist/src/index.js';
import { NatsBroker } from '../packages/broker-nats/dist/src/index.js';
import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from '../packages/security/dist/src/index.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-first-contact-'));
  const file = join(dir, 'murmur.db');
  let store = new SQLiteDedupeOutboxStore(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const keys = await createSigningKeyPair(), invalid = [];
  const broker = new NatsBroker({ url: 'nats://unused.invalid' });
  const createdAt = new Date().toISOString();
  const envelope = (id, peer = 'receiver') => ({ schemaVersion: '1.0', msgId: id, conversationId: 'first-contact',
    senderAgentId: 'sender', recipients: [peer], createdAt,
    payloadCiphertext: 'eA==', payloadNonce: 'nonce', signature: 'sig' });
  const enqueue = async (id, reason, peer = 'receiver') => {
    await store.enqueue(`msg.${peer}`, envelope(id, peer));
    if (reason) await store.markDlq(id, reason);
  };
  const ack = async (id, mutate = x => x) => {
    const unsigned = createBoundAck(envelope(id), 'receiver', 'ack');
    const signed = { ...unsigned, signature: await signEnvelope(stableAckPayload(unsigned), keys.privateKey) };
    await broker.processAckFrame(StringCodec().encode(JSON.stringify(mutate(signed))), {
      outbox: store, ackReceipts: store, recoverFirstContact: true,
      verifyAck: candidate => verifyEnvelopeSignature(stableAckPayload(candidate), candidate.signature, keys.publicKey),
      onInvalidAck: event => invalid.push(event.reason),
    });
  };
  return { enqueue, ack, invalid, broker, get store() { return store; },
    restart() { store.close(); store = new SQLiteDedupeOutboxStore(file); } };
}

test('first signed ACK recovers only waiting letters, survives restart, and preserves envelope IDs', async t => {
  const f = await fixture(t);
  await f.enqueue('early', 'max-attempts:ack-timeout');
  await f.enqueue('not-added', 'max-attempts:unknown-sender:sender');
  await f.enqueue('security', 'poison-message:signature-invalid:sender');
  await f.enqueue('other', 'max-attempts:ack-timeout', 'other');
  await f.enqueue('probe');
  const before = (await f.store.getOutboxRecord('early')).envelope;
  f.restart();
  await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('probe')).status, 'acked');
  for (const id of ['early', 'not-added']) {
    const row = await f.store.getOutboxRecord(id);
    assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0); assert.equal(row.lastError, undefined);
  }
  assert.deepEqual((await f.store.getOutboxRecord('early')).envelope, before);
  for (const id of ['security', 'other']) assert.equal((await f.store.getOutboxRecord(id)).status, 'dlq');
  f.restart();
  await f.enqueue('later', 'max-attempts:ack-timeout'); await f.enqueue('probe-2'); await f.ack('probe-2');
  assert.equal((await f.store.getOutboxRecord('later')).status, 'dlq', 'established Contacts retain bounded retries');
  assert.deepEqual(f.invalid, []);
});

test('a delayed first ACK can settle its own timeout letter without publishing it again', async t => {
  const f = await fixture(t); await f.enqueue('late', 'max-attempts:ack-timeout');
  await f.ack('late');
  assert.equal((await f.store.getOutboxRecord('late')).status, 'acked');
  assert.deepEqual(f.invalid, []);
});

test('an acknowledged group letter does not prove a direct exchange with every member', async t => {
  const f = await fixture(t); await f.enqueue('early', 'max-attempts:ack-timeout');
  const group = { ...(await f.store.getOutboxRecord('early')).envelope,
    msgId: 'group', recipients: ['receiver', 'another-member'] };
  await f.store.enqueue('msg.group', group);
  // Historical group status does not retain which member supplied its receipt.
  await f.store.markAcked('group');
  await f.enqueue('probe'); await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('early')).status, 'pending');
  assert.equal((await f.store.getOutboxRecord('group')).status, 'acked');
  assert.deepEqual(f.invalid, []);
});

for (const reason of ['poison-message:signature-invalid', 'policy-rejected:denied', 'max-attempts:missing-column', 'jetstream-advisory:terminated:x']) {
  test(`first ACK does not resurrect terminal failure ${reason}`, async t => {
    const f = await fixture(t); await f.enqueue('terminal', reason); await f.ack('terminal');
    assert.equal((await f.store.getOutboxRecord('terminal')).status, 'dlq');
    assert.deepEqual(f.invalid, ['message-not-in-flight']);
  });
}

for (const [name, mutate] of [
  ['signature', x => ({ ...x, signature: 'invalid' })],
  ['digest', x => ({ ...x, messageDigest: 'wrong' })],
  ['sender', x => ({ ...x, senderAgentId: 'untrusted' })],
  ['age', x => ({ ...x, at: '2000-01-01T00:00:00Z' })],
]) test(`unverified ${name} cannot recover a waiting letter`, async t => {
  const f = await fixture(t); await f.enqueue('early', 'max-attempts:ack-timeout'); await f.enqueue('probe');
  await f.ack('probe', mutate);
  assert.equal((await f.store.getOutboxRecord('early')).status, 'dlq');
  assert.equal((await f.store.getOutboxRecord('probe')).status, 'pending');
  assert.equal(f.invalid.length, 1);
});
