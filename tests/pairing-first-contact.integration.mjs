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
async function until(fn, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(50); }
  throw new Error('isolated-pairing.timeout');
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

test('late first Contact recovery at real default retry timing', { concurrency: 2, timeout: 150000 }, async t => {
  await Promise.all([false, true].map(jetstream => t.test(jetstream ? 'JetStream' : 'plain NATS', async t => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-first-live-'))), children = [];
    let nc;
    t.after(async () => { await nc?.close(); for (const child of children.reverse()) await stop(child); await fs.rm(dir, { recursive: true, force: true }); });
    const server = spawn('nats-server', ['-a', '127.0.0.1', '-p', '-1', ...(jetstream ? ['-js', '-sd', path.join(dir, 'js')] : [])], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(server);
    let serverLog = '';
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
    const env = id => ({ PATH: process.env.PATH, HOME: dir, USERPROFILE: dir,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), DATA_DIR: path.join(dir, id) });
    const cli = async (id, ...args) => JSON.parse((await exec(process.execPath,
      ['packages/setup/bin/murmur.mjs', ...args, '--data-dir', path.join(dir, id), '--json'], { cwd: root, env: env(id) })).stdout);
    const configPath = id => path.join(dir, id, 'agent-config.json');
    const config = async id => JSON.parse(await fs.readFile(configPath(id), 'utf8'));
    const read = (id, sql, ...params) => {
      const db = new DatabaseSync(path.join(dir, id, 'murmur.db'), { readOnly: true });
      try { return db.prepare(sql).get(...params); } finally { db.close(); }
    };
    const start = async id => {
      const child = spawn(process.execPath, ['scripts/murmur-daemon.mjs'], { cwd: root, env: env(id), stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); let ready = false;
      child.stdout.on('data', chunk => { if (chunk.toString().includes('Daemon ready')) ready = true; });
      child.stderr.on('data', () => {});
      await until(() => { if (child.exitCode !== null) throw new Error('isolated-daemon-exited'); return ready; });
      return child;
    };
    await cli('a', 'init', '--agent-id', 'a', '--broker-url', url);
    // Configure only the disposable test identities, before their processes start.
    if (jetstream) await fs.writeFile(configPath('a'), JSON.stringify({ ...await config('a'), jetstream: { enabled: true, stream: 'PAIRING_TEST' } }));
    const sender = await start('a'), senderPid = sender.pid;
    assert.deepEqual((await config('a')).peers, {});
    await cli('a', 'invite', '--broker', 'nats://server.example.com:4222', '--out', path.join(dir, 'invitation'));
    await cli('b', 'join', '--agent-id', 'b', '--invite-file', path.join(dir, 'invitation'), '--reply-out', path.join(dir, 'reply'));
    await fs.writeFile(configPath('b'), JSON.stringify({ ...await config('b'), natsUrl: url,
      ...(jetstream ? { jetstream: { enabled: true, stream: 'PAIRING_TEST' } } : {}) }));
    const imported = await cli('a', 'add-peer', '--reply-file', path.join(dir, 'reply'));
    assert.equal(imported.restartRequired, false);
    const a = await config('a'), b = await config('b'), msgId = randomUUID();
    const encrypted = await encryptPayload('Synthetic first letter', b.keys.encryption.publicKey, a.keys.encryption.privateKey);
    const envelope = { schemaVersion: '1.0', msgId, conversationId: 'first-contact-test', senderAgentId: 'a', recipients: ['b'],
      createdAt: new Date().toISOString(), payloadCiphertext: encrypted.ciphertext, payloadNonce: encrypted.nonce, signature: '' };
    envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), a.keys.signing.privateKey);
    const store = new SQLiteDedupeOutboxStore(path.join(dir, 'a', 'murmur.db'));
    const started = Date.now();
    try { await store.enqueue('msg.b', envelope); } finally { store.close(); }
    await until(() => read('a', 'SELECT status FROM outbox WHERE msg_id=?', msgId)?.status === 'dlq', 105000);
    await delay(Math.max(0, 86000 - (Date.now() - started)));
    assert.equal(read('a', 'SELECT last_error FROM outbox WHERE msg_id=?', msgId).last_error, 'max-attempts:ack-timeout');
    await start('b');
    // In plain NATS the first ACK comes from a fresh diagnostic exchange. With
    // JetStream it may come from the original persisted letter's late delivery.
    await probeRoundtrip(resolveContext({ dataDir: path.join(dir, 'a'), repoRoot: root }), a, 'b', nc, 12000);
    await until(() => read('a', 'SELECT status FROM outbox WHERE msg_id=?', msgId)?.status === 'acked');
    await delay(2200); // Give queued duplicate deliveries another normal flush tick.
    assert.equal(read('b', 'SELECT COUNT(*) n FROM local_messages WHERE msg_id=?', msgId).n, 1);
    assert.equal(read('b', 'SELECT text FROM local_messages WHERE msg_id=?', msgId).text, 'Synthetic first letter');
    assert.equal(sender.pid, senderPid); assert.equal(sender.exitCode, null);
    console.log(JSON.stringify({ jetstream, elapsedMs: Date.now() - started, senderRestarted: false, firstLetter: 'acked', storedCopies: 1 }));
  })));
});
