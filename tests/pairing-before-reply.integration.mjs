import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { connect } from 'nats';
import { SQLiteDedupeOutboxStore, stableEnvelopePayload } from '../packages/core/dist/src/index.js';
import { encryptPayload, signEnvelope } from '../packages/security/dist/src/index.js';
import { probeRoundtrip } from '../packages/setup/dist/src/doctor.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';

const root = fileURLToPath(new URL('../', import.meta.url)), exec = promisify(execFile);
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(50); }
  throw new Error('before-reply.timeout');
}
async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

test('joiner sends before the running inviter imports the Reply', { concurrency: 2, timeout: 60000 }, async t => {
  await Promise.all([false, true].map(jetstream => t.test(jetstream ? 'JetStream' : 'plain NATS', async t => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-before-reply-'))), children = [];
    let nc;
    t.after(async () => { await nc?.close(); for (const child of children.reverse()) await stop(child); await fs.rm(dir, { recursive: true, force: true }); });
    const server = spawn('nats-server', ['-a', '127.0.0.1', '-p', '-1', ...(jetstream ? ['-js', '-sd', path.join(dir, 'js')] : [])], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(server); let serverLog = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('isolated-server-start-timeout')), 10000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.stderr.on('data', chunk => {
        serverLog += chunk;
        const port = serverLog.match(/Listening for client connections on 127\.0\.0\.1:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve(`nats://127.0.0.1:${port}`); }
      });
    });
    nc = await connect({ servers: url, reconnect: false });
    const env = id => ({ PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, DATA_DIR: path.join(dir, id), FLUSH_INTERVAL_MS: '200',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });
    const cli = async (id, ...args) => JSON.parse((await exec(process.execPath,
      ['packages/setup/bin/murmur.mjs', ...args, '--data-dir', path.join(dir, id), '--json'], { cwd: root, env: env(id) })).stdout);
    const configPath = id => path.join(dir, id, 'agent-config.json');
    const config = async id => JSON.parse(await fs.readFile(configPath(id), 'utf8'));
    const tune = async id => fs.writeFile(configPath(id), JSON.stringify({ ...await config(id), natsUrl: url,
      streaming: { ackTimeoutMs: 200 }, ...(jetstream ? { jetstream: { enabled: true, stream: 'PAIRING_TEST', maxDeliver: 2, ackWaitMs: 200 } } : {}) }));
    const read = (id, sql, ...args) => {
      const db = new DatabaseSync(path.join(dir, id, 'murmur.db'), { readOnly: true });
      try { return db.prepare(sql).get(...args); } finally { db.close(); }
    };
    const start = async id => {
      const child = spawn(process.execPath, ['scripts/murmur-daemon.mjs'], { cwd: root, env: env(id), stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); let ready = false;
      child.stdout.on('data', chunk => { if (chunk.toString().includes('Daemon ready')) ready = true; });
      child.stderr.on('data', () => {});
      await until(() => { if (child.exitCode !== null) throw new Error('isolated-daemon-exited'); return ready; });
      return child;
    };
    const advisories = [];
    if (jetstream) {
      const sub = nc.subscribe('$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.PAIRING_TEST.a');
      void (async () => { for await (const m of sub) advisories.push(JSON.parse(m.string())); })();
      await nc.flush();
    }
    await cli('a', 'init', '--agent-id', 'a', '--broker-url', url); await tune('a');
    const inviter = await start('a');
    await cli('a', 'invite', '--broker', 'nats://server.example.com:4222', '--out', path.join(dir, 'invitation'));
    await cli('b', 'join', '--agent-id', 'b', '--invite-file', path.join(dir, 'invitation'), '--reply-out', path.join(dir, 'reply'));
    await tune('b');
    const a = await config('a'), b = await config('b');
    // A bad third Contact cannot take the valid pair or the whole Service down.
    await fs.writeFile(configPath('b'), JSON.stringify({ ...b, peers: { ...b.peers, bad: { subject: 'msg.bad' } } }));
    const joiner = await start('b');
    const diagnostic = async () => {
      try { return JSON.parse(await fs.readFile(path.join(dir, 'b', 'daemon-observation.json'), 'utf8')).contacts; }
      catch { return null; }
    };
    assert.equal((await diagnostic()).state, 'partial');
    assert.equal((await diagnostic()).count, 1);
    const enqueue = async () => {
      const msgId = randomUUID();
      const payload = await encryptPayload('Synthetic before-Reply letter', a.keys.encryption.publicKey, b.keys.encryption.privateKey);
      const envelope = { schemaVersion: '1.0', msgId, conversationId: 'before-reply', senderAgentId: 'b', recipients: ['a'],
        createdAt: new Date().toISOString(), payloadCiphertext: payload.ciphertext, payloadNonce: payload.nonce, signature: '' };
      envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), b.keys.signing.privateKey);
      const store = new SQLiteDedupeOutboxStore(path.join(dir, 'b', 'murmur.db'));
      try { await store.enqueue('msg.a', envelope); } finally { store.close(); }
      return msgId;
    };
    const delivered = async id => {
      await until(() => read('b', 'SELECT status FROM outbox WHERE msg_id=?', id)?.status === 'acked');
      assert.equal(read('a', 'SELECT COUNT(*) n FROM local_messages WHERE msg_id=?', id).n, 1);
    };
    const msgId = await enqueue();
    await until(() => read('b', 'SELECT status FROM outbox WHERE msg_id=?', msgId)?.status === 'dlq');
    if (jetstream) await until(() => advisories.length > 0);
    await delay(500); // The sender must process the real advisory before Contact import.
    assert.equal(read('a', 'SELECT COUNT(*) n FROM local_messages WHERE msg_id=?', msgId).n, 0);
    const before = read('b', 'SELECT last_error FROM outbox WHERE msg_id=?', msgId).last_error;
    await cli('a', 'add-peer', '--reply-file', path.join(dir, 'reply'));
    await probeRoundtrip(resolveContext({ dataDir: path.join(dir, 'b'), repoRoot: root }), b, 'a', nc, 12000);
    await delivered(msgId);
    await delay(500);
    assert.equal(read('a', 'SELECT COUNT(*) n FROM local_messages WHERE msg_id=?', msgId).n, 1);
    for (const [contents, reason] of [
      ['{invalid', 'agent-config-unavailable-retry-or-restart'],
      [JSON.stringify({ ...b, subject: 'msg.changed' }), 'agent-config-runtime-changed-restart-required'],
    ]) {
      await fs.writeFile(configPath('b'), contents);
      await until(async () => (await diagnostic())?.lastError === reason);
      await delivered(await enqueue());
    }
    await fs.writeFile(configPath('b'), JSON.stringify(b));
    await until(async () => (await diagnostic())?.state === 'current');
    assert.equal(inviter.exitCode, null); assert.equal(joiner.exitCode, null);
    console.log(JSON.stringify({ jetstream, before, maxDeliverAdvisories: advisories.length, firstLetter: 'acked', storedCopies: 1,
      invalidContactStartup: 'ready', malformedConfigDelivery: 'acked', changedRuntimeDelivery: 'acked', reloadAfterRepair: 'current' }));
  })));
});
