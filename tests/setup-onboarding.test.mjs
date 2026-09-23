import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { main } from '../packages/setup/dist/src/cli.js';
import { readStatus } from '../packages/setup/dist/src/status.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { assertMode, skipWithoutSymlinks } from './windows-host.mjs';
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
  assertMode(t, (await fs.stat(invitation)).mode, 0o600, 'invite mode');
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
test('the invite warning names what is inside, and says password only when a credential is there', async t => {
  const f = await fixture(t);
  await f.init('agent-a');
  const plain = await f.command('agent-a', ['invite', '--out', path.join(f.root, 'plain-invite')]);
  assert.equal(plain.containsBrokerCredential, false);
  assert.ok(!/password/i.test(plain.instruction), 'a profile without a broker credential must not be called a password');
  assert.match(plain.instruction, /identity/i);

  const token = path.join(f.root, 'token'); await fs.writeFile(token, 'broker-secret');
  await f.command('agent-b', ['init', '--agent-id', 'agent-b', '--broker-url', 'nats://127.0.0.1:4222', '--token-file', token]);
  const secret = await f.command('agent-b', ['invite', '--out', path.join(f.root, 'secret-invite')]);
  assert.equal(secret.containsBrokerCredential, true);
  assert.match(secret.instruction, /password/i, 'an invite carrying a broker credential must say so in the words a person acts on');
  assert.match(secret.instruction, /credential/i);

  assert.notEqual(plain.instruction, secret.instruction, 'one sentence for both cases teaches people to ignore it');
  for (const r of [plain, secret]) assert.match(r.instruction, /does not prove pairing/);
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
  const store = new SQLiteDedupeOutboxStore(path.join(f.root, 'agent-a', 'murmur.db'));
  try {
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
  } finally { store.close(); }
});
test('join output conflict does not create a half-imported identity', async t => {
  const f=await fixture(t); await f.init('agent-a');
  const invitation=path.join(f.root,'invite'), reply=path.join(f.root,'existing-reply');
  await f.command('agent-a',['invite','--out',invitation]); await fs.writeFile(reply,'keep');
  await assert.rejects(f.command('agent-b',['join','--agent-id','agent-b','--invite-file',invitation,'--reply-out',reply]),{code:'EEXIST'});
  assert.equal(await fs.readFile(reply,'utf8'),'keep');
  await assert.rejects(f.config('agent-b'),{code:'ENOENT'});
});
for (const managed of ['agent-config.json','murmur.db','read-state.json']) test(`join rejects managed output ${managed} before profile mutation`, async t=>{
  const f=await fixture(t);await f.init('agent-a');const invitation=path.join(f.root,'invite');
  await f.command('agent-a',['invite','--out',invitation]);
  const data=path.join(f.root,'agent-b');await fs.mkdir(data);
  await assert.rejects(f.command('agent-b',['join','--agent-id','agent-b','--invite-file',invitation,'--reply-out',path.join(data,managed)]),/output-inside-profile/);
  assert.deepEqual(await fs.readdir(data),[]);
});
test('invite and join reject symlink-parent aliases into a managed profile',{ skip: skipWithoutSymlinks },async t=>{
  const f=await fixture(t);await f.init('agent-a');
  const data=path.join(f.root,'agent-b');await fs.mkdir(data);const alias=path.join(f.root,'alias');await fs.symlink(data,alias,'dir');
  const invitation=path.join(f.root,'invite');await f.command('agent-a',['invite','--out',invitation]);
  await assert.rejects(f.command('agent-b',['join','--agent-id','agent-b','--invite-file',invitation,'--reply-out',path.join(alias,'future-state.json')]),/output-inside-profile/);
  await assert.rejects(f.command('agent-a',['invite','--out',path.join(f.root,'agent-a','murmur.db')]),/output-inside-profile/);
  assert.deepEqual(await fs.readdir(data),[]);
  await assert.rejects(fs.stat(path.join(f.root,'agent-a','murmur.db')),{code:'ENOENT'});
});
test('join requires an existing output parent before creating the profile',async t=>{
  const f=await fixture(t);await f.init('agent-a');const invitation=path.join(f.root,'invite');await f.command('agent-a',['invite','--out',invitation]);
  await assert.rejects(f.command('agent-b',['join','--agent-id','agent-b','--invite-file',invitation,'--reply-out',path.join(f.root,'missing-parent','reply')]),/output-parent-required/);
  await assert.rejects(fs.stat(path.join(f.root,'agent-b')),{code:'ENOENT'});
});
test('case-insensitive volumes reject fresh and existing mixed-case profile output aliases',async t=>{
  const f=await fixture(t);const check=path.join(f.root,'case-probe');await fs.mkdir(check);
  const actual=await fs.stat(check), alias=await fs.stat(path.join(f.root,'CASE-PROBE')).catch(()=>null);
  if(!alias || actual.ino!==alias.ino){t.skip('volume is case-sensitive');return;}
  await f.init('agent-a');const invitation=path.join(f.root,'invite');await f.command('agent-a',['invite','--out',invitation]);
  const output=path.join(f.root,'CASEFOLD','agent-config.json');
  await assert.rejects(f.command('casefold',['join','--agent-id','casefold','--invite-file',invitation,'--reply-out',output]),/output-parent-required/);
  await assert.rejects(fs.stat(path.join(f.root,'casefold')),{code:'ENOENT'});
  await fs.mkdir(path.join(f.root,'casefold'));
  await assert.rejects(f.command('casefold',['join','--agent-id','casefold','--invite-file',invitation,'--reply-out',output]),/output-inside-profile/);
  assert.deepEqual(await fs.readdir(path.join(f.root,'casefold')),[]);
});
