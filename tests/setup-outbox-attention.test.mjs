import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../packages/setup/dist/src/cli.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { readStatus } from '../packages/setup/dist/src/status.js';
import { listOutboxAttention, setOutboxDismissed } from '../packages/setup/dist/src/outbox-attention.js';
import { SQLiteMessageStore, SQLiteDedupeOutboxStore } from '../packages/core/dist/src/index.js';
import { assertPrivateFile } from './helpers/private-files.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur attention проба '));
  const context = resolveContext({ dataDir: root, repoRoot: fileURLToPath(new URL('../', import.meta.url)) });
  const key = Buffer.alloc(32, 1).toString('base64');
  const config = { agentId: 'agent-a', subject: 'msg.agent-a', natsUrl: 'nats://127.0.0.1:4222',
    keys: { signing: { publicKey: key, privateKey: key }, encryption: { publicKey: key, privateKey: key } }, peers: {} };
  await fs.writeFile(context.configPath, JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'read-state.json'), '{"preserve":"inbox cursor"}');
  new SQLiteMessageStore(context.storePath).close(); new SQLiteDedupeOutboxStore(context.storePath).close();
  const db = new DatabaseSync(context.storePath);
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const add = (id = 'old-smoke', status = 'dlq', error = 'CONNECTION_CLOSED') => db.prepare(
    'INSERT INTO outbox(msg_id,subject,envelope_json,status,attempts,next_attempt_at,last_error,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(id, 'msg.agent-b', JSON.stringify({ recipients: ['agent-b'], content: 'PRIVATE-MESSAGE-DO-NOT-EXPOSE', signature: 'PRIVATE-ENVELOPE' }),
    status, 15, '2026-05-12T13:00:21Z', error, '2026-05-09T02:05:48Z', '2026-05-12T13:00:21Z', 4);
  add();
  const rows = () => db.prepare('SELECT * FROM outbox ORDER BY msg_id').all();
  const list = () => listOutboxAttention(context);
  const adapter = { manager: 'none', status: async () => ({ state: 'stopped' }) };
  return { root, context, config, db, add, rows, list, adapter, sidecar: path.join(root, 'outbox-attention.json') };
}

test('outbox metadata shows the failed send rather than a later historical error, without reading a body into the result', async t => {
  const f = await fixture(t); f.add('delivered-later', 'acked', 'database is locked');
  const before = f.rows(), files = await fs.readdir(f.root), report = await f.list();
  assert.equal(report.total, 1); assert.equal(report.pending, 1); assert.equal(report.items[0].peer, 'agent-b');
  assert.equal(report.items[0].createdAt, '2026-05-09T02:05:48Z'); assert.equal(report.items[0].reason, 'CONNECTION_CLOSED');
  assert.ok(!JSON.stringify(report).includes('PRIVATE-')); assert.ok(!JSON.stringify(report).includes('database is locked'));
  assert.deepEqual(f.rows(), before); assert.deepEqual(await fs.readdir(f.root), files);
});

test('dismiss and restore affect only reversible private warning state, never outbox/config/cursor', async t => {
  const f = await fixture(t), item = (await f.list()).items[0], before = f.rows();
  const config = await fs.readFile(f.context.configPath), cursor = await fs.readFile(path.join(f.root, 'read-state.json'));
  const args = ['--msg-id', item.msgId, '--expected-state', item.token, '--expected-agent', 'agent-a', '--data-dir', f.root];
  const receipt = await main(['outbox', 'dismiss', ...args]);
  assert.deepEqual({ state: receipt.transportState, resent: receipt.resent, kept: receipt.historyPreserved }, { state: 'dlq', resent: false, kept: true });
  await assertPrivateFile(f.sidecar);
  assert.equal((await f.list()).pending, 0); assert.equal((await f.list()).items[0].dismissed, true);
  const once = await fs.readFile(f.sidecar); await main(['outbox', 'dismiss', ...args]); assert.deepEqual(await fs.readFile(f.sidecar), once);
  const status = await readStatus({ context: f.context, adapter: f.adapter });
  assert.equal(status.outbox.queue.dlq, 1); assert.equal(status.outbox.queue.delivered, 0); assert.equal(status.outbox.attention.pending, 0);
  await main(['outbox', 'restore', ...args]); assert.equal((await f.list()).pending, 1);
  assert.deepEqual(f.rows(), before); assert.deepEqual(await fs.readFile(f.context.configPath), config);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'read-state.json')), cursor);
});

test('a changed record reappears and an old selection cannot acknowledge its new failure', async t => {
  const f = await fixture(t), item = (await f.list()).items[0];
  await setOutboxDismissed(f.context, item.msgId, item.token, 'agent-a', true);
  const before = await fs.readFile(f.sidecar);
  f.db.prepare('UPDATE outbox SET version=version+1,last_error=? WHERE msg_id=?').run('ack-timeout', item.msgId);
  assert.equal((await f.list()).pending, 1);
  await assert.rejects(setOutboxDismissed(f.context, item.msgId, item.token, 'agent-a', true), /outbox.record-changed/);
  assert.deepEqual(await fs.readFile(f.sidecar), before); assert.ok(!(await fs.readdir(f.root)).includes('.setup-write.lock'));
});

test('wrong profile identity, active messages and invalid selection never create acknowledgement state', async t => {
  const f = await fixture(t), item = (await f.list()).items[0];
  await assert.rejects(setOutboxDismissed(f.context, item.msgId, item.token, 'agent-other', true), /outbox.identity-changed/);
  f.db.prepare("UPDATE outbox SET status='failed' WHERE msg_id=?").run(item.msgId);
  await assert.rejects(setOutboxDismissed(f.context, item.msgId, item.token, 'agent-a', true), /outbox.record-not-found/);
  await assert.rejects(setOutboxDismissed(f.context, '../outside', item.token, 'agent-a', true), /outbox.selection-invalid/);
  await assert.rejects(fs.stat(f.sidecar), { code: 'ENOENT' });
});

test('invalid or foreign saved acknowledgements fail closed without hiding a dead letter', async t => {
  const f = await fixture(t), item = (await f.list()).items[0];
  for (const value of ['not json', JSON.stringify({ schema: 'murmur.outbox-dismissals/1', agentId: 'agent-other', records: [item] })]) {
    await fs.writeFile(f.sidecar, value);
    await assert.rejects(f.list(), /outbox.dismissals-/);
    const status = await readStatus({ context: f.context, adapter: f.adapter });
    assert.equal(status.outbox.queue.dlq, 1); assert.ok(status.outbox.attention.unknownReason);
    await assert.rejects(setOutboxDismissed(f.context, item.msgId, item.token, 'agent-a', true), /outbox.dismissals-/);
    assert.equal(await fs.readFile(f.sidecar, 'utf8'), value);
  }
});

test('outbox inspection does not create an absent database', async t => {
  const f = await fixture(t); f.context.storePath = path.join(f.root, 'absent.db');
  await assert.rejects(f.list()); await assert.rejects(fs.stat(f.context.storePath), { code: 'ENOENT' });
});

test('older acknowledgements remain reachable and oversized metadata sets fail closed', async t => {
  const f = await fixture(t), item = (await f.list()).items[0];
  await setOutboxDismissed(f.context, item.msgId, item.token, 'agent-a', true);
  for (let n = 0; n < 199; n++) f.add(`failure-${n}`);
  const report = await f.list();
  assert.equal(report.items.length, 200);
  assert.equal(report.items.at(-1).msgId, item.msgId);
  assert.equal(report.items.at(-1).dismissed, true);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 200 * 1024);
  await setOutboxDismissed(f.context, item.msgId, item.token, 'agent-a', false);
  assert.equal((await f.list()).pending, 200);
  f.add('over-limit');
  await assert.rejects(f.list(), /outbox.attention-limit-exceeded/);
  const status = await readStatus({ context: f.context, adapter: f.adapter });
  assert.equal(status.outbox.queue.dlq, 201);
  assert.equal(status.outbox.attention.unknownReason, 'outbox.attention-limit-exceeded');
});
