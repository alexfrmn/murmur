import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../packages/setup/dist/src/cli.js';
import { humanError } from '../packages/setup/dist/src/config.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const adapter = { manager: 'none' };

async function fixture(t) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-lines-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  // Windows PowerShell creates AppData under USERPROFILE while applying ACLs.
  // Keep OS home state separate so the exchange directory proves no files are needed.
  const dir = path.join(sandbox, 'exchange'), home = path.join(sandbox, 'home');
  await fs.mkdir(dir); await fs.mkdir(home);
  const command = (id, args, input) => main([...args, '--data-dir', path.join(dir, id)], adapter, input);
  const config = id => fs.readFile(path.join(dir, id, 'agent-config.json'), 'utf8').then(JSON.parse);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MURMUR_') && !key.startsWith('NATS_') && !['DATA_DIR', 'STORE_PATH', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  const cli = (id, args, input = '') => spawnSync(process.execPath, ['packages/setup/bin/murmur.mjs', ...args, '--data-dir', path.join(dir, id)], {
    cwd: root, env: { ...env, HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') },
    input, encoding: 'utf8', timeout: 15000,
  });
  await command('a', ['init', '--agent-id', 'a', '--broker-url', 'nats://server.example.com:4222']);
  return { dir, command, config, cli };
}

test('real CLI forms a pair using exactly two MURMUR lines and no exchange files', async t => {
  const f = await fixture(t);
  const invitation = f.cli('a', ['invite']);
  assert.equal(invitation.status, 0, invitation.stderr); assert.match(invitation.stdout, /^MURMUR:[A-Za-z0-9_-]+\n$/);
  assert.equal(invitation.stderr, '');
  const reply = f.cli('b', ['join', '--agent-id', 'b', '--invite-stdin'], invitation.stdout);
  assert.equal(reply.status, 0, reply.stderr); assert.match(reply.stdout, /^MURMUR:[A-Za-z0-9_-]+\n$/);
  assert.equal(reply.stderr, '');
  const imported = f.cli('a', ['add-peer', '--reply-stdin', '--json'], reply.stdout);
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(JSON.parse(imported.stdout).contactsReload, { mechanism: 'config-file', state: 'pending' });
  assert.equal(JSON.parse(imported.stdout).restartRequired, false);
  const a = await f.config('a'), b = await f.config('b');
  assert.equal(a.peers.b.signing.publicKey, b.keys.signing.publicKey);
  assert.equal(b.peers.a.encryption.publicKey, a.keys.encryption.publicKey);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['a', 'b']);
});

test('JSON carries the strings, optional file copies match them, and the credential flag remains explicit', async t => {
  const f = await fixture(t), config = await f.config('a');
  config.natsToken = 'synthetic-access-key';
  await fs.writeFile(path.join(f.dir, 'a', 'agent-config.json'), JSON.stringify(config));
  const invitation = await f.command('a', ['invite', '--out', path.join(f.dir, 'invitation'), '--json']);
  assert.equal(invitation.containsBrokerCredential, true);
  assert.match(invitation.instruction, /Server access key.*personally/);
  assert.equal(await fs.readFile(invitation.file, 'utf8'), invitation.invitation + '\n');
  const body = JSON.parse(Buffer.from(invitation.invitation.slice(7), 'base64url'));
  assert.equal(body.natsToken, 'synthetic-access-key'); assert.equal(JSON.stringify(body).includes('privateKey'), false);
  const reply = await f.command('b', ['join', '--agent-id', 'b', '--invite-file', invitation.file, '--reply-out', path.join(f.dir, 'reply'), '--json']);
  assert.equal(await fs.readFile(reply.replyFile, 'utf8'), reply.reply + '\n');
  assert.equal(JSON.parse(Buffer.from(reply.reply.slice(7), 'base64url')).type, 'reply');
  assert.equal(reply.reply.includes('synthetic-access-key'), false);
});

for (const [name, content] of [
  ['damaged', 'MURMUR:not-valid!'], ['two lines', 'MURMUR:e30\nMURMUR:e30'], ['oversized', 'MURMUR:' + 'A'.repeat(16384)],
]) test(`stdin rejects ${name} before creating an Identity`, async t => {
  const f = await fixture(t), result = f.cli('b', ['join', '--agent-id', 'b', '--invite-stdin'], content);
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /onboarding\.|MURMUR:/);
  await assert.rejects(fs.stat(path.join(f.dir, 'b')), { code: 'ENOENT' });
});

test('stdin/file conflict and wrong message type leave both Identities unchanged', async t => {
  const f = await fixture(t), before = await f.config('a');
  const invitation = await f.command('a', ['invite']);
  const args = ['join', '--agent-id', 'b', '--invite-stdin', '--invite-file', path.join(f.dir, 'missing')];
  await assert.rejects(f.command('b', args, [invitation.invitation]), /input-conflict/);
  await assert.rejects(f.command('a', ['add-peer', '--reply-stdin'], [invitation.invitation]), /invalid-peer/);
  assert.deepEqual(await f.config('a'), before);
  await assert.rejects(fs.stat(path.join(f.dir, 'b')), { code: 'ENOENT' });
});

test('old canonical base64 Invitations and MURMUR-REPLY Replies remain accepted', async t => {
  const f = await fixture(t), invitation = await f.command('a', ['invite']);
  const legacy = 'MURMUR:' + Buffer.from(invitation.invitation.slice(7), 'base64url').toString('base64');
  const reply = await f.command('b', ['join', '--agent-id', 'b', '--invite-stdin'], [legacy]);
  const oldReply = 'MURMUR-REPLY:' + Buffer.from(reply.reply.slice(7), 'base64url').toString('base64');
  await f.command('a', ['add-peer', '--reply-stdin'], [oldReply]);
  assert.ok((await f.config('a')).peers.b);
});

test('an Invitation too large to import is refused before creating its optional file', async t => {
  const f = await fixture(t), config = await f.config('a'); config.natsToken = 'x'.repeat(16384);
  await fs.writeFile(path.join(f.dir, 'a', 'agent-config.json'), JSON.stringify(config));
  const file = path.join(f.dir, 'oversized');
  await assert.rejects(f.command('a', ['invite', '--out', file]), /input-too-large/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('the generated line limit includes the newline written to stdout and files', async t => {
  const f = await fixture(t), config = await f.config('a');
  const invitation = await f.command('a', ['invite']);
  const body = JSON.parse(Buffer.from(invitation.invitation.slice(7), 'base64url'));
  const size = (16384 - 1 - 'MURMUR:'.length) * 3 / 4 - Buffer.byteLength(JSON.stringify({ ...body, natsToken: '' }));
  config.natsToken = 'x'.repeat(size + 1);
  await fs.writeFile(path.join(f.dir, 'a', 'agent-config.json'), JSON.stringify(config));
  await assert.rejects(f.command('a', ['invite']), /input-too-large/);
  config.natsToken = 'x'.repeat(size);
  await fs.writeFile(path.join(f.dir, 'a', 'agent-config.json'), JSON.stringify(config));
  const accepted = f.cli('a', ['invite']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(Buffer.byteLength(accepted.stdout), 16384);
  const reply = f.cli('b', ['join', '--agent-id', 'b', '--invite-stdin'], accepted.stdout);
  assert.equal(reply.status, 0, reply.stderr);
});

test('every human error is an actionable sentence while JSON keeps its code', async t => {
  const f = await fixture(t);
  const codes = ['onboarding.input-conflict', 'onboarding.input-required', 'onboarding.input-too-large', 'onboarding.invalid-peer-key',
    'onboarding.existing-profile-conflict', 'onboarding.peer-key-conflict', 'config.missing', 'cli.unknown-option',
    'cli.required-option:agent-id', 'onboarding.invite-file-not-found', 'onboarding.reply-file-access-denied',
    'unknown.machine.code', 'constructor'];
  for (const code of codes) {
    const human = humanError(new Error(code));
    assert.equal(typeof human, 'string'); assert.match(human, /[.!]$/); assert.notEqual(human, code);
    assert.doesNotMatch(human, /\b(peer|agent|broker|daemon|profile|blob)s?\b/i);
  }
  const args = ['join', '--agent-id', 'b', '--invite-stdin'];
  const json = f.cli('b', [...args, '--json'], 'MURMUR:invalid!');
  assert.equal(json.status, 1); assert.equal(json.stdout, ''); assert.equal(json.stderr.trim(), 'onboarding.invalid-blob');
  const human = f.cli('b', args, 'MURMUR:invalid!');
  assert.equal(human.stderr.trim(), humanError(new Error('onboarding.invalid-blob')));
});
