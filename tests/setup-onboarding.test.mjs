import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { main } from '../packages/setup/dist/src/cli.js';
import { readStatus } from '../packages/setup/dist/src/status.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
const adapter = { manager: 'none', status: async () => ({ state: 'stopped', manager: 'none', pid: null, since: null, lastExitCode: null, observedStorePath: null, restartCount: null, restartWindowMs: null }) };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-onboard-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = (id, args) => main([...args, '--data-dir', path.join(root, id)], adapter);
  const config = id => fs.readFile(path.join(root, id, 'agent-config.json'), 'utf8').then(JSON.parse);
  const init = id => command(id, ['init', '--agent-id', id, '--broker-url', 'nats://127.0.0.1:4222']);
  return { root, command, config, init };
}
test('two profiles can exchange private invite/reply files without shell-specific env syntax', async t => {
  const f = await fixture(t); await f.init('agent-a');
  const invitation = path.join(f.root, 'invite.txt'), reply = path.join(f.root, 'reply.txt');
  await f.command('agent-a', ['invite', '--out', invitation]);
  const result = await f.command('agent-b', ['join', '--agent-id', 'agent-b', '--invite-file', invitation, '--reply-out', reply]);
  assert.equal(result.paired, null); assert.equal(result.restartRequired, true);
  await f.command('agent-a', ['add-peer', '--reply-file', reply]);
  const a = await f.config('agent-a'), b = await f.config('agent-b');
  assert.equal(a.peers['agent-b'].signing.publicKey, b.keys.signing.publicKey);
  assert.equal(b.peers['agent-a'].encryption.publicKey, a.keys.encryption.publicKey);
  const context = resolveContext({ dataDir: path.join(f.root, 'agent-a'), repoRoot: fileURLToPath(new URL('../', import.meta.url)) });
  assert.equal((await readStatus({ context, adapter })).peers.list[0].paired, null);
  assert.equal((await fs.stat(invitation)).mode & 0o777, 0o600);
  assert.ok(!Buffer.from((await fs.readFile(invitation, 'utf8')).trim().slice(7), 'base64').toString().includes('privateKey'));
});
test('repeat init/add-peer preserves existing identity and rejects a peer key change', async t => {
  const f = await fixture(t); await f.init('agent-a'); const before = await f.config('agent-a');
  assert.equal((await f.init('agent-a')).existing, true); assert.deepEqual((await f.config('agent-a')).keys, before.keys);
  await assert.rejects(f.command('agent-a', ['init', '--agent-id', 'other', '--broker-url', 'nats://127.0.0.1:4222']), /existing-profile-conflict/);
  const reply = path.join(f.root, 'reply.txt');
  const value = { v: 1, type: 'reply', agentId: 'agent-b', subject: 'msg.agent-b', encryption: { publicKey: before.keys.encryption.publicKey }, signing: { publicKey: before.keys.signing.publicKey } };
  const write = () => fs.writeFile(reply, 'MURMUR-REPLY:' + Buffer.from(JSON.stringify(value)).toString('base64'));
  await write(); await f.command('agent-a', ['add-peer', '--reply-file', reply]);
  assert.equal((await f.command('agent-a', ['add-peer', '--reply-file', reply])).backup, null);
  value.signing.publicKey = Buffer.alloc(32, 1).toString('base64'); await write();
  await assert.rejects(f.command('agent-a', ['add-peer', '--reply-file', reply]), /peer-key-conflict/);
  assert.equal((await f.config('agent-a')).peers['agent-b'].signing.publicKey, before.keys.signing.publicKey);
});
test('malformed invite fails before profile creation and never overwrites an output file', async t => {
  const f = await fixture(t), file = path.join(f.root, 'bad.txt'); await fs.writeFile(file, 'MURMUR:broken');
  await assert.rejects(f.command('agent-a', ['join', '--agent-id', 'agent-a', '--invite-file', file, '--reply-out', path.join(f.root, 'reply')]), /invalid-blob/);
  await assert.rejects(f.config('agent-a'), { code: 'ENOENT' });
  await f.init('agent-a');
  await assert.rejects(f.command('agent-a', ['invite', '--out', file]), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'MURMUR:broken');
});
test('broker credentials come from a private input file and are absent from command result', async t => {
  const f = await fixture(t), token = path.join(f.root, 'token'); await fs.writeFile(token, 'fixture-secret-token\n', { mode: 0o600 });
  const result = await f.command('agent-a', ['init', '--agent-id', 'agent-a', '--broker-url', 'nats://127.0.0.1:4222', '--token-file', token]);
  assert.ok(!JSON.stringify(result).includes('fixture-secret-token'));
  assert.equal((await f.config('agent-a')).natsToken, 'fixture-secret-token');
});
test('add-peer clears only this peer poisoned dedupe rows and preserves delivered rows', async t => {
  const { SQLiteDedupeOutboxStore } = await import('../packages/core/dist/src/index.js');
  const f = await fixture(t); await f.init('agent-a'); const config = await f.config('agent-a');
  const store = new SQLiteDedupeOutboxStore(path.join(f.root, 'agent-a', 'murmur.db')); t.after(() => store.close());
  await store.markSeen('blocked', 'consumer', { senderAgentId:'agent-b', poisonReason:'unknown-peer' });
  await store.markSeen('delivered', 'consumer', { senderAgentId:'agent-b' });
  await store.markSeen('other', 'consumer', { senderAgentId:'agent-c', poisonReason:'unknown-peer' });
  const file = path.join(f.root, 'reply');
  await fs.writeFile(file, 'MURMUR-REPLY:' + Buffer.from(JSON.stringify({ v:1,type:'reply',agentId:'agent-b',subject:'msg.agent-b',encryption:{publicKey:config.keys.encryption.publicKey},signing:{publicKey:config.keys.signing.publicKey} })).toString('base64'));
  const result = await f.command('agent-a', ['add-peer','--reply-file',file]);
  assert.deepEqual(result.poisonReset,{cleared:1,reason:null});
  assert.equal(await store.seen('blocked','consumer'),false);
  assert.equal(await store.seen('delivered','consumer'),true);
  assert.equal(await store.seen('other','consumer'),true);
});
