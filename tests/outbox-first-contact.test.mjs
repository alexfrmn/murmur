import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringCodec } from 'nats';
import { SQLiteDedupeOutboxStore, createBoundAck, stableAckPayload } from '../packages/core/dist/src/index.js';
import { NatsBroker } from '../packages/broker-nats/dist/src/index.js';
import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from '../packages/security/dist/src/index.js';
import { listOutboxAttention, setOutboxDismissed } from '../packages/setup/dist/src/outbox-attention.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-first-contact-'));
  const file = join(dir, 'murmur.db');
  let store = new SQLiteDedupeOutboxStore(file);
  const cleanup = [];
  t.after(() => { for (const close of cleanup) close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
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
    const unsigned = createBoundAck((await store.getOutboxRecord(id)).envelope, 'receiver', 'ack');
    const signed = { ...unsigned, signature: await signEnvelope(stableAckPayload(unsigned), keys.privateKey) };
    await broker.processAckFrame(StringCodec().encode(JSON.stringify(mutate(signed))), {
      outbox: store, ackReceipts: store, recoverFirstContact: true,
      verifyAck: candidate => verifyEnvelopeSignature(stableAckPayload(candidate), candidate.signature, keys.publicKey),
      onInvalidAck: event => invalid.push(event.reason),
    });
  };
  const advisory = async (id, kind = 'max_deliver', timestamp = new Date().toISOString()) => {
    broker.jsm = { streams: { getMessage: async () => ({ data: StringCodec().encode(JSON.stringify((await store.getOutboxRecord(id)).envelope)) }) } };
    await broker.processJetStreamAdvisoryFrame(StringCodec().encode(JSON.stringify({
      type: `io.nats.jetstream.advisory.v1.${kind}`, timestamp, stream: 'MURMUR', consumer: 'receiver', stream_seq: 1, deliveries: 5,
    })), store);
  };
  const context = resolveContext({ dataDir: dir });
  const key = Buffer.alloc(32, 7).toString('base64');
  writeFileSync(context.configPath, JSON.stringify({ agentId: 'sender', subject: 'msg.sender', natsUrl: 'nats://test.invalid',
    keys: { encryption: { publicKey: key, privateKey: key }, signing: { publicKey: key, privateKey: key } }, peers: {} }), { mode: 0o600 });
  return { enqueue, ack, advisory, invalid, broker, context, file, cleanup, get store() { return store; },
    restart() { store.close(); store = new SQLiteDedupeOutboxStore(file); } };
}

test('first Contact recovery respects a dismissal made through the setup API', async t => {
  const f = await fixture(t);
  for (const id of ['hidden', 'visible']) await f.enqueue(id, 'max-attempts:ack-timeout');
  const item = (await listOutboxAttention(f.context)).items.find(i => i.msgId === 'hidden');
  await setOutboxDismissed(f.context, item.msgId, item.token, 'sender', true);
  const before = await f.store.getOutboxRecord('hidden');
  await f.enqueue('probe'); await f.ack('probe');
  assert.deepEqual(await f.store.getOutboxRecord('hidden'), before);
  assert.equal((await f.store.getOutboxRecord('visible')).status, 'pending');
  assert.equal((await f.store.getOutboxRecord('probe')).status, 'acked');
});

for (const action of ['restore', 'changed-state']) test(`first Contact recovery accepts a ${action} dismissal`, async t => {
  const f = await fixture(t); await f.enqueue('letter', 'max-attempts:ack-timeout');
  const item = (await listOutboxAttention(f.context)).items[0];
  await setOutboxDismissed(f.context, item.msgId, item.token, 'sender', true);
  if (action === 'restore') await setOutboxDismissed(f.context, item.msgId, item.token, 'sender', false);
  else await f.store.markDlq('letter', 'max-attempts:unknown-sender:sender');
  await f.enqueue('probe'); await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('letter')).status, 'pending');
});

test('automatic recovery is bounded to seven days from both envelope and local creation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T12:00:00Z') });
  const f = await fixture(t), db = new DatabaseSync(f.file);
  f.cleanup.push(() => db.close());
  for (const [id, age] of [['at-limit', 7 * 86400000], ['expired', 7 * 86400000 + 1], ['future', -6000]]) {
    await f.enqueue(id, 'max-attempts:ack-timeout');
    db.prepare('UPDATE outbox SET created_at=? WHERE msg_id=?').run(new Date(Date.now() - age).toISOString(), id);
  }
  await f.enqueue('old-envelope', 'max-attempts:ack-timeout');
  db.prepare("UPDATE outbox SET envelope_json=json_set(envelope_json,'$.createdAt',?) WHERE msg_id='old-envelope'")
    .run(new Date(Date.now() - 8 * 86400000).toISOString());
  await f.enqueue('probe'); await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('at-limit')).status, 'pending');
  for (const id of ['expired', 'future', 'old-envelope']) assert.equal((await f.store.getOutboxRecord(id)).status, 'dlq');
});

for (const obstacle of ['invalid-file', 'foreign-file', 'locked']) test(`recovery does not guess dismissal state when ${obstacle}`, async t => {
  const f = await fixture(t); await f.enqueue('waiting', 'max-attempts:ack-timeout');
  const lock = join(f.context.dataDir, '.setup-write.lock');
  if (obstacle === 'locked') mkdirSync(lock);
  else writeFileSync(join(f.context.dataDir, 'outbox-attention.json'), obstacle === 'invalid-file' ? '{invalid'
    : JSON.stringify({ schema: 'murmur.outbox-dismissals/1', agentId: 'another', records: [] }));
  await f.enqueue('probe'); await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('waiting')).status, 'dlq');
  assert.equal((await f.store.getOutboxRecord('probe')).status, 'acked');
  assert.equal(existsSync(lock), obstacle === 'locked', 'only a lock this operation owns may be removed');
});

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

for (const policy of ['dismissed', 'expired']) test(`a verified late ACK may settle its own ${policy} letter without requeueing`, async t => {
  const f = await fixture(t);
  await f.enqueue('late', 'max-attempts:ack-timeout');
  if (policy === 'dismissed') {
    const item = (await listOutboxAttention(f.context)).items[0];
    await setOutboxDismissed(f.context, item.msgId, item.token, 'sender', true);
  } else {
    const db = new DatabaseSync(f.file); f.cleanup.push(() => db.close());
    db.prepare("UPDATE outbox SET created_at=? WHERE msg_id='late'").run(new Date(Date.now() - 8 * 86400000).toISOString());
  }
  const before = await f.store.getOutboxRecord('late');
  await f.ack('late');
  const after = await f.store.getOutboxRecord('late');
  assert.equal(after.status, 'acked'); assert.equal(after.attempts, before.attempts);
  assert.deepEqual(after.envelope, before.envelope);
  assert.deepEqual(await f.store.claimDue(), []);
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

test('a member first ACK neither revives a group DLQ nor recovers direct letters via a group receipt', async t => {
  const f = await fixture(t); await f.enqueue('direct', 'max-attempts:ack-timeout');
  const group = { ...(await f.store.getOutboxRecord('direct')).envelope, recipients: ['receiver', 'another-member'] };
  await f.store.enqueue('msg.receiver', { ...group, msgId: 'group-waiting' });
  await f.store.markDlq('group-waiting', 'max-attempts:ack-timeout');
  await f.store.enqueue('msg.receiver', { ...group, msgId: 'group-probe' });
  await f.ack('group-probe');
  assert.equal((await f.store.getOutboxRecord('direct')).status, 'dlq');
  await f.enqueue('direct-probe'); await f.ack('direct-probe');
  assert.equal((await f.store.getOutboxRecord('direct')).status, 'pending');
  assert.equal((await f.store.getOutboxRecord('group-waiting')).status, 'dlq');
  await f.ack('group-waiting');
  assert.equal((await f.store.getOutboxRecord('group-waiting')).status, 'dlq');
  assert.deepEqual(f.invalid, ['message-not-in-flight']);
});

test('max-deliver advisory preserves first-contact and security DLQ reasons', async t => {
  const f = await fixture(t);
  for (const [id, reason] of [['waiting', 'max-attempts:unknown-sender:sender'], ['security', 'poison-message:signature-invalid'],
    ['policy', 'policy-rejected:denied'], ['terminated', 'jetstream-advisory:terminated:receiver']]) {
    await f.enqueue(id, reason); await f.advisory(id);
    assert.equal((await f.store.getOutboxRecord(id)).lastError, reason);
  }
  await f.enqueue('probe'); await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('waiting')).status, 'pending');
  for (const id of ['security', 'policy', 'terminated']) assert.equal((await f.store.getOutboxRecord(id)).status, 'dlq');
});

test('max-deliver before the outbox attempt cap is recoverable on the first direct ACK', async t => {
  const f = await fixture(t); await f.enqueue('early'); await f.advisory('early');
  assert.match((await f.store.getOutboxRecord('early')).lastError, /^jetstream-advisory:max_deliver:/);
  await f.enqueue('probe'); await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('early')).status, 'pending');
});

test('termination remains final even after a first-contact timeout', async t => {
  const f = await fixture(t); await f.enqueue('early', 'max-attempts:ack-timeout'); await f.advisory('early', 'terminated');
  await f.enqueue('probe'); await f.ack('probe');
  assert.equal((await f.store.getOutboxRecord('early')).status, 'dlq');
  assert.match((await f.store.getOutboxRecord('early')).lastError, /^jetstream-advisory:terminated:/);
});

test('late or racing advisory cannot undo a settled ACK', async t => {
  const f = await fixture(t); await f.enqueue('acked'); await f.ack('acked'); await f.advisory('acked');
  assert.equal((await f.store.getOutboxRecord('acked')).status, 'acked');
  await f.enqueue('racing');
  const markDlq = f.store.markDlq.bind(f.store);
  f.store.markDlq = async (id, reason, version) => { await f.store.markAcked(id); await markDlq(id, reason, version); };
  await f.advisory('racing');
  assert.equal((await f.store.getOutboxRecord('racing')).status, 'acked');
});

test('an advisory issued before first-contact recovery cannot close the requeued letter', async t => {
  const f = await fixture(t); await f.enqueue('early', 'max-attempts:ack-timeout');
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  await f.enqueue('probe'); await f.ack('probe');
  await f.advisory('early', 'max_deliver', issuedAt);
  assert.equal((await f.store.getOutboxRecord('early')).status, 'pending');
  await f.ack('early');
  assert.equal((await f.store.getOutboxRecord('early')).status, 'acked');
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
