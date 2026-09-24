import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteMessageStore, SQLiteDedupeOutboxStore } from '../packages/core/dist/src/index.js';
import { readStatus, pairFingerprint, resolveContext, statusVerdict } from '../packages/setup/dist/src/index.js';
import { createDaemonObservation } from '../scripts/daemon-observation.mjs';
import { readInbox, markInboxRead } from '../packages/setup/dist/src/commands.js';
import { main } from '../packages/setup/dist/src/cli.js';
const now = Date.parse('2026-09-19T13:00:00Z'), at = new Date(now).toISOString();
const key = Buffer.alloc(32, 7).toString('base64');
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-status-'));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const context = resolveContext({ dataDir, repoRoot: fileURLToPath(new URL('../', import.meta.url)) });
  const config = { agentId: 'agent-a', subject: 'msg.agent-a', natsUrl: 'nats://127.0.0.1:4222',
    keys: { signing: { publicKey: key, privateKey: key }, encryption: { publicKey: key, privateKey: key } },
    peers: { 'agent-b': { subject: 'msg.agent-b', signing: { publicKey: key }, encryption: { publicKey: key } } }, wake: { enabled: true, mode: 'codex_app_server' } };
  await fs.writeFile(context.configPath, JSON.stringify(config), { mode: 0o600 });
  new SQLiteMessageStore(context.storePath).close(); new SQLiteDedupeOutboxStore(context.storePath).close();
  const snapshot = { state: 'running', manager: 'systemd', pid: 12345, since: at, lastExitCode: null,
    observedStorePath: await fs.realpath(context.storePath), restartCount: null, restartWindowMs: null };
  const observation = { schema: 'murmur.runtime/1', measuredAt: at, pid: snapshot.pid, agentId: config.agentId,
    storePath: snapshot.observedStorePath, broker: { state: 'connected', connectedAt: at, lastError: null, lastErrorAt: null },
    wake: { enabled: true, mode: 'monitor', responder: 'codex', lastFault: null, lastFaultAt: null } };
  const write = (file, value) => fs.writeFile(path.join(dataDir, file), JSON.stringify(value));
  await write('daemon-observation.json', observation);
  await write('read-state.json', { schema: 'murmur.read/1', agentId: config.agentId, rowid: 0 });
  const adapter = { manager: 'systemd', status: async () => snapshot };
  const read = () => readStatus({ context, adapter, now: () => now });
  const db = new DatabaseSync(context.storePath); cleanup.push(() => db.close());
  return { context, config, snapshot, observation, write, read, db, cleanup, adapter };
}
test('live store-bound daemon without the selected service label is running-unmanaged', async t => {
  const f = await fixture(t);
  f.snapshot.state = 'stopped'; f.snapshot.pid = null; f.snapshot.observedStorePath = null;
  f.adapter.observeStore = async (context, pid) => {
    assert.equal(context, f.context); assert.equal(pid, f.observation.pid);
    return f.observation.storePath;
  };
  const s = await f.read();
  assert.equal(s.service.state, 'running-unmanaged');
  assert.equal(s.service.pid, f.observation.pid);
  assert.equal(s.service.observedStorePath, f.observation.storePath);
  assert.equal(s.service.managed, false);
  assert.equal(s.broker.state, 'connected');
  assert.equal(statusVerdict(s, now).code, 'ok');
});
test('an unmanaged observation is not liveness evidence without the PID holding this store', async t => {
  const f = await fixture(t); f.snapshot.state = 'stopped';
  f.snapshot.pid = null; f.snapshot.observedStorePath = null;
  for (const observed of [null, '/another/murmur.db']) {
    f.adapter.observeStore = async () => observed;
    const s = await f.read();
    assert.equal(s.service.state, 'stopped'); assert.equal(s.broker.state, 'unknown');
  }
  f.adapter.observeStore = async () => { throw new Error('unavailable'); };
  assert.equal((await f.read()).service.state, 'stopped');
  f.adapter.observeStore = async () => f.observation.storePath;
  for (const delta of [{ pid: -1 }, { pid: 1.5 }, { agentId: 'another' }, { measuredAt: new Date(now - 15001).toISOString() }]) {
    await f.write('daemon-observation.json', { ...f.observation, ...delta });
    assert.equal((await f.read()).service.state, 'stopped');
  }
});
test('contact exchange uses successful traffic, never an enqueued or failed send', async t => {
  const f = await fixture(t);
  const insert = f.db.prepare("INSERT INTO outbox(msg_id,subject,envelope_json,status,attempts,next_attempt_at,created_at,updated_at,version) VALUES(?,?,?,?,0,?,?,?,0)");
  for (const state of ['pending', 'sent', 'failed', 'dlq']) insert.run(state, 'msg.agent-b', JSON.stringify({ recipients: ['agent-b'] }), state, at, at, at);
  let peer = (await f.read()).peers.list[0];
  assert.equal(peer.lastExchangeAt, null); assert.equal(peer.connection, 'unverified');
  const exchanged = new Date(now - 86400000).toISOString();
  insert.run('ack', 'msg.agent-b', JSON.stringify({ recipients: ['agent-b'] }), 'acked', exchanged, exchanged, exchanged);
  peer = (await f.read()).peers.list[0];
  assert.equal(peer.lastExchangeAt, exchanged); assert.equal(peer.connection, 'connected');
  f.db.prepare("UPDATE outbox SET updated_at=? WHERE msg_id='ack'").run(new Date(now - 86400001).toISOString());
  assert.equal((await f.read()).peers.list[0].connection, 'stale');
  f.db.prepare("INSERT INTO local_messages(id,conversation_id,msg_id,direction,sender,text,created_at,wake_status) VALUES('in','c','in','inbound','agent-b','test',?,'pending')").run(at);
  peer = (await f.read()).peers.list[0];
  assert.equal(peer.lastExchangeAt, at); assert.equal(peer.connection, 'connected');
});
test('status reads real durable counters, no local-key-only pairing claim or file writes', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.context.configPath);
  const s = await f.read();
  assert.equal(s.outbox.queue.failed, 0); assert.equal(s.inbox.unread, 0);
  assert.equal(s.peers.list[0].paired, null); assert.equal(statusVerdict(s, now).level, 'green');
  assert.deepEqual(await fs.readFile(f.context.configPath), before);
});
test('fresh roundtrip proof is bound to identity, keys and one-day expiry', async t => {
  const f = await fixture(t);
  const proof = { peerId: 'agent-b', localAgentId: 'agent-a', keyFingerprint: pairFingerprint(f.config, 'agent-b'), verifiedAt: at };
  await f.write('pair-proofs.json', { 'agent-b': proof });
  assert.equal((await f.read()).peers.list[0].paired, true);
  proof.verifiedAt = new Date(now - 86400001).toISOString(); await f.write('pair-proofs.json', { 'agent-b': proof });
  assert.equal((await f.read()).peers.list[0].paired, null);
  proof.verifiedAt = at; proof.keyFingerprint = 'old-keys'; await f.write('pair-proofs.json', { 'agent-b': proof });
  assert.equal((await f.read()).peers.list[0].paired, null);
});
test('stale, wrong PID, wrong FD and malformed runtime observations are unknown, not connected', async t => {
  const f = await fixture(t);
  for (const delta of [{ measuredAt: new Date(now - 15001).toISOString() }, { pid: 54321 }, { broker: { state: 'invented' } }, { wake: { enabled: 'yes', mode: 'monitor' } }]) {
    await f.write('daemon-observation.json', { ...f.observation, ...delta });
    const s = await f.read(); assert.equal(s.broker.state, 'unknown'); assert.equal(s.wake.effective.enabled, null);
    assert.equal(s.outbox.queue.failed, 0);
  }
  await f.write('daemon-observation.json', f.observation); f.snapshot.observedStorePath = null;
  assert.equal((await f.read()).broker.state, 'unknown');
});
test('missing read cursor stays unknown while total is measured', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.context.dataDir, 'read-state.json'));
  const s = await f.read(); assert.equal(s.inbox.total, 0); assert.equal(s.inbox.unread, null); assert.ok(s.inbox.unknownReason);
});
test('stored-only is neither a wake failure nor a successful wake', async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO local_messages(id,conversation_id,msg_id,direction,sender,text,created_at,wake_status,wake_error) VALUES(?,?,?,?,?,?,?,?,?)")
    .run('1','c','1','inbound','agent-b','private text',at,'stored-only','wake-no-responder');
  const s = await f.read(); assert.equal(s.wake.delivery.storedOnly, 1); assert.equal(s.wake.delivery.pendingUndelivered, 0);
  assert.equal(s.wake.delivery.lastDeliveredAt, null); assert.equal(s.wake.faults.lastFault, null); assert.equal(s.inbox.unread, 1);
  assert.ok(!JSON.stringify(s).includes('private text'));
});
test('monitor crash survives SQLite write failure through independent runtime observation', async t => {
  const f = await fixture(t); f.observation.wake.lastFault = 'wake.database-locked'; f.observation.wake.lastFaultAt = at;
  await f.write('daemon-observation.json', f.observation);
  const s = await f.read(); assert.equal(s.wake.faults.lastFault, 'wake.database-locked');
  assert.equal(s.wake.delivery.pendingUndelivered, 0); assert.equal(statusVerdict(s, now).code, 'wake.fault');
});
test('configured pause does not pretend to change the running daemon', async t => {
  const f = await fixture(t); f.config.wake.enabled = false; await f.write('agent-config.json', f.config);
  const s = await f.read(); assert.equal(s.wake.config.enabled, false); assert.equal(s.wake.effective.enabled, true);
  assert.equal(s.wake.effective.needsRestart, true); assert.equal(statusVerdict(s, now).code, 'wake.mode-mismatch');
});
test('restart-loop threshold applies only to an exactly measured hour', async t => {
  const f = await fixture(t); f.snapshot.restartCount = 5; f.snapshot.restartWindowMs = 60000;
  assert.equal((await f.read()).service.restartsLastHour, null);
  f.snapshot.restartWindowMs = 3600000;
  const s = await f.read(); assert.equal(s.service.state, 'failed'); assert.equal(s.service.restartFailureThreshold, 5);
});
test('missing database is not created by a status read', async t => {
  const f = await fixture(t); f.context.storePath = path.join(f.context.dataDir, 'absent.db');
  const s = await f.read(); assert.equal(s.outbox.queue.failed, null); assert.ok(s.outbox.faults.unknownReason);
  await assert.rejects(fs.stat(f.context.storePath), { code: 'ENOENT' });
});
test('Windows private profile does not share the public service metadata directory', () => {
  const c = resolveContext({ platform: 'win32', home: 'C:\\Users\\me', repoRoot: 'C:\\Murmur', nodePath: 'C:\\node.exe', env: { ProgramData: 'D:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } });
  assert.equal(c.dataDir, 'C:\\Users\\me\\AppData\\Local\\Murmur');
  assert.equal(c.logDir, c.dataDir + '\\logs');
});
test('runtime observer captures only safe fault codes without command/output contents', async t => {
  const f = await fixture(t);
  const observation = createDaemonObservation({ dataDir: f.context.dataDir, storePath: f.context.storePath, agentId: 'agent-a', wake: { enabled: true, mode: 'monitor' } });
  f.cleanup.push(() => observation.stop()); await observation.start();
  await observation.observeLog('error', 'WakeMonitor lane crashed', { error: 'database is locked', secret: 'do-not-copy' });
  const text = await fs.readFile(path.join(f.context.dataDir, 'daemon-observation.json'), 'utf8');
  assert.equal(JSON.parse(text).wake.lastFault, 'wake.database-locked');
  assert.ok(!text.includes('do-not-copy'));
});
test('message read cursor never claims the Assistant handled a message', async t => {
  const f = await fixture(t);
  const insert = f.db.prepare("INSERT INTO local_messages(id,conversation_id,msg_id,direction,sender,text,created_at,wake_status,wake_updated_at) VALUES(?,'c',?,'inbound','agent-b','synthetic',?,?,?)");
  const statuses = ['handled', 'pending', 'inflight', 'failed', 'dlq', 'muted', 'stored-only', null];
  for (const [i, status] of statuses.entries()) insert.run(String(i), String(i), at, status, at);
  for (const mark of [false, true]) {
    if (mark) await markInboxRead(f.context);
    const result = await readInbox(f.context);
    assert.equal(result.messages.length, statuses.length);
    for (const row of result.messages) {
      assert.equal(row.wake_status, statuses[Number(row.msgId)]);
      assert.equal(row.assistantRead, row.wake_status === null ? null : row.wake_status === 'handled');
      assert.equal(row.unread, !mark);
    }
  }
  const status = await f.read();
  assert.equal(status.deliveries.find(row => row.msgId === '0').assistantRead, true);
  assert.equal(status.deliveries.find(row => row.msgId === '1').wake_status, 'pending');
});
test('initial Server failure is persisted and logged as a safe reason', async t => {
  const f = await fixture(t), logs = [];
  const observation = createDaemonObservation({ dataDir: f.context.dataDir, storePath: f.context.storePath,
    agentId: 'agent-a', wake: { enabled: true, mode: 'monitor' }, log: (...args) => logs.push(args) });
  f.cleanup.push(() => observation.stop()); await observation.start();
  const read = async () => JSON.parse(await fs.readFile(path.join(f.context.dataDir, 'daemon-observation.json'), 'utf8'));
  assert.equal((await read()).broker.lastError, 'broker.connecting');
  for (const [reason, state] of [['broker.connection-refused', 'disconnected'], ['broker.unauthorized', 'unauthorized']]) {
    await observation.onStatus({ type: 'connect_error', data: { reason, secret: 'do-not-copy' } });
    const row = await read();
    assert.equal(row.broker.state, state); assert.equal(row.broker.lastError, reason);
    assert.ok(row.broker.lastErrorAt);
    assert.ok(logs.some(row => row[2]?.reason === reason));
    assert.ok(!JSON.stringify(row).includes('do-not-copy'));
  }
  await observation.connected(); assert.equal((await read()).broker.state, 'connected');
});
test('unmanaged liveness never authorizes a lifecycle operation against another label', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  await f.write('daemon-observation.json', { ...f.observation, measuredAt: at });
  f.snapshot.state = 'stopped'; f.snapshot.pid = null; f.snapshot.observedStorePath = null;
  f.adapter.observeStore = async () => f.observation.storePath;
  const operations = [];
  for (const action of ['install', 'start', 'stop', 'uninstall']) f.adapter[action] = async () => operations.push(action);
  for (const action of ['install', 'start', 'stop', 'uninstall']) {
    await assert.rejects(main(['service', action, '--data-dir', f.context.dataDir], f.adapter), /service.running-unmanaged/);
  }
  const paused = await main(['wake', 'pause', '--apply', '--data-dir', f.context.dataDir], f.adapter);
  assert.equal(paused.applyError, 'service.running-unmanaged');
  assert.equal(paused.effectiveEnabled, true); assert.equal(paused.restartRequired, true);
  assert.deepEqual(operations, []);
});
test('inbox returns 20 newest legacy messages with unknown Assistant receipt without migration', async t => {
  const f = await fixture(t);
  const legacy = path.join(f.context.dataDir, 'legacy.db'), db = new DatabaseSync(legacy);
  db.exec('CREATE TABLE local_messages(conversation_id TEXT,msg_id TEXT,direction TEXT,sender TEXT,text TEXT,created_at TEXT,transport TEXT,channel_id TEXT,sender_member_id TEXT,addressee_member_id TEXT)');
  for (let i = 0; i < 24; i++) db.prepare("INSERT INTO local_messages(conversation_id,msg_id,direction,sender,text,created_at) VALUES('c',?,'inbound','agent-b','synthetic',?)").run(String(i), at);
  const before = db.prepare('PRAGMA table_info(local_messages)').all();
  const result = await readInbox({ ...f.context, storePath: legacy });
  assert.equal(result.messages.length, 20); assert.equal(result.messages[0].msgId, '23');
  assert.ok(result.messages.every(row => row.wake_status === null && row.assistantRead === null));
  assert.deepEqual(db.prepare('PRAGMA table_info(local_messages)').all(), before);
  db.close();
});
