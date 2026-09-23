import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { connect, StringCodec } from 'nats';
import { SQLiteMessageStore, SQLiteDedupeOutboxStore, stableEnvelopePayload } from '../packages/core/dist/src/index.js';
import { createKeyPair, createSigningKeyPair, encryptPayload, decryptPayload, signEnvelope } from '../packages/security/dist/src/index.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { main } from '../packages/setup/dist/src/cli.js';
import { runDoctor, probeRoundtrip } from '../packages/setup/dist/src/doctor.js';
import { assertPrivateFile, allowPublicReadInFixtureDirectory, fileAccessPolicy } from './helpers/private-files.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const stopped = { manager: 'none', status: async () => ({ state: 'stopped', manager: 'none', pid: null, since: null, lastExitCode: null, observedStorePath: null, restartCount: null, restartWindowMs: null }) };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-cli-')), cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const context = resolveContext({ dataDir, repoRoot: root });
  const config = { agentId: 'agent-a', subject: 'msg.agent-a', natsUrl: 'nats://127.0.0.1:4222', keys: { signing: await createSigningKeyPair(), encryption: await createKeyPair() }, peers: {}, wake: { enabled: true } };
  const save = () => fs.writeFile(context.configPath, JSON.stringify(config)); await save();
  new SQLiteMessageStore(context.storePath).close(); new SQLiteDedupeOutboxStore(context.storePath).close();
  return { context, config, save, cleanup };
}
test('CLI emits formed JSON with exit zero for missing config and stopped daemon', async t => {
  const f = await fixture(t); await fs.unlink(f.context.configPath);
  for (const command of ['status', 'doctor']) {
    const raw = execFileSync(process.execPath, ['packages/setup/bin/murmur.mjs', command, '--data-dir', f.context.dataDir, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(JSON.parse(raw).schema, `murmur.${command}/1`);
  }
  const report = await runDoctor({ context: f.context, adapter: stopped });
  assert.equal(report.summary.failedStage, 'config');
  assert.deepEqual(report.stages.slice(1).map(s => [s.state, s.reason]), Array(5).fill(['skip', 'blocked-by:config']));
});
test('doctor stops at daemon and gives all six stages without broker side effects', async t => {
  const f = await fixture(t); const report = await runDoctor({ context: f.context, adapter: stopped });
  assert.equal(report.summary.failedStage, 'daemon'); assert.equal(report.stages.length, 6);
  assert.deepEqual(report.stages.slice(2).map(s => s.reason), Array(4).fill('blocked-by:daemon'));
});
test('pause command backs up private config and honestly reports required restart', async t => {
  const f = await fixture(t);
  if (process.platform === 'win32') await allowPublicReadInFixtureDirectory(f.context.dataDir);
  const accessBefore = process.platform === 'win32' ? await fileAccessPolicy(f.context.configPath) : null;
  const result = await main(['wake', 'pause', '--data-dir', f.context.dataDir], stopped);
  assert.equal(result.configuredEnabled, false); assert.equal(result.effectiveEnabled, null); assert.equal(result.restartRequired, true);
  assert.equal(JSON.parse(await fs.readFile(f.context.configPath, 'utf8')).wake.enabled, false);
  assert.equal(JSON.parse(await fs.readFile(result.backup, 'utf8')).wake.enabled, true);
  await assertPrivateFile(result.backup);
  if (process.platform === 'win32') assert.equal(await fileAccessPolicy(f.context.configPath), accessBefore);
  else await assertPrivateFile(f.context.configPath);
  const again = await main(['wake', 'pause', '--data-dir', f.context.dataDir], stopped); assert.equal(again.backup, null);
});
test('explicit mark-read advances only the chosen contour cursor', async t => {
  const f = await fixture(t); const state = await main(['inbox', 'mark-read', '--data-dir', f.context.dataDir], stopped);
  assert.equal(state.rowid, 0); assert.equal(state.agentId, 'agent-a');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.context.dataDir, 'read-state.json'), 'utf8')), state);
});
test('real NATS roundtrip needs valid peer signature AND local daemon persistence', async t => {
  try { execFileSync('nats-server', ['--version'], { stdio: 'ignore' }); } catch { t.skip('isolated nats-server binary unavailable'); return; }
  const f = await fixture(t), peerKeys = { encryption: await createKeyPair(), signing: await createSigningKeyPair() };
  f.config.peers['agent-b'] = { subject: 'msg.agent-b', encryption: { publicKey: peerKeys.encryption.publicKey }, signing: { publicKey: peerKeys.signing.publicKey } }; await f.save();
  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const broker = spawn('nats-server', ['-a', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' });
  f.cleanup.push(async () => { if (broker.exitCode === null) { broker.kill('SIGTERM'); await new Promise(resolve => broker.once('exit', resolve)); } });
  let nc;
  for (let i = 0; i < 50 && !nc; i++) { try { nc = await connect({ servers: `nats://127.0.0.1:${port}`, reconnect: false }); } catch { await delay(20); } }
  assert.ok(nc, 'isolated broker starts'); f.cleanup.push(() => nc.close());
  const db = new DatabaseSync(f.context.storePath); f.cleanup.push(() => db.close());
  const subscriptions = [], subscribe = nc.subscribe.bind(nc);
  nc.subscribe = (subject, ...rest) => { subscriptions.push(subject); return subscribe(subject, ...rest); };
  let done = false;
  const pending = probeRoundtrip(f.context, f.config, 'agent-b', nc, 3000).then(result => { done = true; return result; });
  let request;
  for (let i = 0; i < 100 && !request; i++) { request = db.prepare('SELECT envelope_json FROM outbox LIMIT 1').get(); if (!request) await delay(10); }
  assert.ok(request, 'probe enters canonical outbox');
  assert.deepEqual(subscriptions, ['msg.agent-a']);
  const sent = JSON.parse(request.envelope_json);
  const plain = await decryptPayload({ ciphertext: sent.payloadCiphertext, nonce: sent.payloadNonce, senderPublicKey: f.config.keys.encryption.publicKey }, peerKeys.encryption.privateKey);
  const replyText = /MURMUR-DOCTOR-REPLY [a-f0-9]+$/.exec(plain)[0];
  const encrypted = await encryptPayload(replyText, f.config.keys.encryption.publicKey, peerKeys.encryption.privateKey);
  const reply = { schemaVersion: '1.0', msgId: 'probe-reply', conversationId: sent.conversationId, senderAgentId: 'agent-b', recipients: ['agent-a'], createdAt: new Date().toISOString(), payloadCiphertext: encrypted.ciphertext, payloadNonce: encrypted.nonce, signature: 'invalid' };
  const codec = StringCodec(); nc.publish('msg.agent-a', codec.encode(JSON.stringify(reply))); await nc.flush(); await delay(50); assert.equal(done, false);
  reply.signature = await signEnvelope(stableEnvelopePayload(reply), peerKeys.signing.privateKey);
  nc.publish('msg.agent-a', codec.encode(JSON.stringify(reply))); await nc.flush(); await delay(50); assert.equal(done, false, 'valid network reply without inbox is insufficient');
  const messages = new SQLiteMessageStore(f.context.storePath);
  try { await messages.append({ msgId: reply.msgId, conversationId: reply.conversationId, sender: 'agent-b', direction: 'inbound', text: replyText, createdAt: reply.createdAt }); } finally { messages.close(); }
  assert.equal((await pending).replyMsgId, reply.msgId);
  const proofs = JSON.parse(await fs.readFile(path.join(f.context.dataDir, 'pair-proofs.json'), 'utf8'));
  assert.equal(proofs['agent-b'].localAgentId, 'agent-a');
});
