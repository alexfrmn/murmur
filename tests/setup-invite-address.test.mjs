import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../packages/setup/dist/src/cli.js';
import { assertPrivateFile } from './helpers/private-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicServer = 'nats://server.example.com:4222';
async function fixture(t, server = 'nats://192.168.35.10:4222') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-invite-address-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile = path.join(directory, 'profile'), output = path.join(directory, 'invitation');
  const command = args => main([...args, '--data-dir', profile], { manager: 'none' });
  await command(['init', '--agent-id', 'sender', '--broker-url', server]);
  const configPath = path.join(profile, 'agent-config.json');
  const before = await fs.readFile(configPath, 'utf8');
  const names = (await fs.readdir(profile)).sort();
  const unchanged = async () => {
    assert.equal(await fs.readFile(configPath, 'utf8'), before);
    assert.deepEqual((await fs.readdir(profile)).sort(), names);
  };
  return { directory, profile, output, command, configPath, unchanged };
}

const privateHosts = [
  '10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255',
  '127.0.0.1', '127.255.255.255', '169.254.0.0', '169.254.255.255', '100.64.0.0', '100.127.255.255',
  '[::1]', '[fc00::]', '[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]', '[fe80::]', '[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  'localhost', 'LOCALHOST.', 'server.localhost', 'machine.local', 'MACHINE.LOCAL.', 'local', 'intranet',
  '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.0.0.1.', '%31%32%37.0.0.1',
  '[::ffff:127.0.0.1]', '[::ffff:a00:1]', '[::ffff:c0a8:230a]', '[::ffff:100.64.0.1]',
  '0.0.0.0', '[::]', '[::192.168.1.1]', '224.0.0.1', '[ff02::1]',
  'server.tailnet.ts.net', 'SERVER.TAILNET.TS.NET.', 'ts.net', 'server.internal', 'SERVER.INTERNAL.',
  'router.home.arpa', 'ROUTER.HOME.ARPA.', 'home.arpa', 'server.lan', 'SERVER.LAN.',
  '192.0.0.0', '192.0.0.255', '192.0.2.0', '192.0.2.255', '198.18.0.0', '198.19.255.255',
  '198.51.100.0', '198.51.100.255', '203.0.113.0', '203.0.113.255',
  '[2001:db8::]', '[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[64:ff9b::]', '[64:ff9b::ffff:ffff]', '[64:ff9b::a01:203]', '[64:ff9b::808:808]',
  '[::ffff:192.0.0.1]', '[::ffff:192.0.2.1]', '[::ffff:198.18.0.1]',
  '[::ffff:198.51.100.1]', '[::ffff:203.0.113.1]',
];
for (const host of privateHosts) test(`invite refuses non-public Server ${host} without creating output`, async t => {
  const f = await fixture(t, `nats://${host}:4222`);
  await assert.rejects(f.command(['invite', '--out', f.output]), /^Error: onboarding\.invite-public-server-required$/);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  await f.unchanged();
});

const publicHosts = [
  'server.example.com', 'SERVER.EXAMPLE.COM.', 'local.example.com', 'localhost.example.com',
  '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0',
  '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0', '100.63.255.255', '100.128.0.0',
  '[2606:4700:4700::1111]', '[::ffff:8.8.8.8]',
  'ts.net.example.com', 'not-ts.net', 'home.arpa.example.com', 'not-home.arpa',
  'internal.example.com', 'lan.example.com',
  '191.255.255.255', '192.0.1.0', '192.0.1.255', '192.0.3.0', '198.17.255.255', '198.20.0.0',
  '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0',
  '[2001:db7:ffff:ffff:ffff:ffff:ffff:ffff]', '[2001:db9::]',
  '[64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff]', '[64:ff9b::1:0:0]',
];
for (const host of publicHosts) test(`invite accepts public Server ${host} without changing the profile`, async t => {
  const server = `nats://${host}:4222`, f = await fixture(t, server);
  const result = await f.command(['invite', '--out', f.output]);
  assert.equal(result.schema, 'murmur.invite/1');
  assert.equal(result.containsBrokerCredential, false);
  const value = JSON.parse(Buffer.from((await fs.readFile(f.output, 'utf8')).trim().slice('MURMUR:'.length), 'base64'));
  assert.equal(value.natsUrl, server);
  await f.unchanged();
});

test('an explicit public --broker only changes the Invitation and preserves the credential flag', async t => {
  const f = await fixture(t);
  const token = 'disposable-test-token';
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.natsToken = token;
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const before = await fs.readFile(f.configPath, 'utf8');
  const result = await f.command(['invite', '--broker', 'tls://server.example.com:4443', '--out', f.output, '--json']);
  assert.equal(result.containsBrokerCredential, true);
  assert.ok(!JSON.stringify(result).includes(token));
  const value = JSON.parse(Buffer.from((await fs.readFile(f.output, 'utf8')).trim().slice('MURMUR:'.length), 'base64'));
  assert.equal(value.natsUrl, 'tls://server.example.com:4443');
  assert.equal(value.natsToken, token);
  assert.ok(!JSON.stringify(value).includes('privateKey'));
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
  await assertPrivateFile(f.output);
});

test('a private --broker cannot bypass the guard even when the configured Server is public', async t => {
  const f = await fixture(t, publicServer);
  for (const host of ['192.168.35.10', '[::1]', 'host.local', 'host.ts.net', 'host.internal', 'host.home.arpa', 'host.lan',
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '[2001:db8::1]', '[64:ff9b::a01:203]']) {
    const server = `tls://${host}:4222`;
    await assert.rejects(f.command(['invite', '--broker', server, '--out', f.output]), /invite-public-server-required/);
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  }
  await f.unchanged();
});

test('invalid Server overrides fail without echoing input or writing output', async t => {
  const f = await fixture(t);
  for (const server of ['', 'server.example.com', 'https://server.example.com', 'nats:server.example.com',
    'nats://', 'nats://server.example.com:0', 'nats://server.example.com:99999', 'nats://server.example.com/path',
    'nats://server.example.com?token=synthetic-secret', 'nats://user:synthetic-secret@server.example.com',
    'nats://server.example.com#fragment', ' nats://server.example.com', 'nats://ser\nver.example.com',
    'nats://server..example.com', 'nats://-server.example.com']) {
    await assert.rejects(f.command(['invite', '--broker', server, '--out', f.output]), /^Error: onboarding\.invite-server-address-invalid$/);
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  }
  await f.unchanged();
});

test('Server override keeps occupied output and profile ownership checks', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'keep');
  await assert.rejects(f.command(['invite', '--broker', publicServer, '--out', f.output]), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.output, 'utf8'), 'keep');
  await assert.rejects(f.command(['invite', '--broker', publicServer, '--out', f.configPath]), /output-inside-profile/);
  await f.unchanged();
});

test('the real CLI gives an actionable sentence normally and a stable code with --json', async t => {
  const f = await fixture(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MURMUR_') && !key.startsWith('NATS_') && !['DATA_DIR', 'STORE_PATH', 'NODE_OPTIONS'].includes(key)));
  for (const [args, expected] of [
    [[], /This Invitation needs a public Server address\..*--broker/],
    [['--json'], /^onboarding\.invite-public-server-required\s*$/],
    [['--broker', 'nats://user:synthetic-secret@server.example.com'], /Enter a valid public Server address.*--broker/],
  ]) {
    const result = spawnSync(process.execPath, ['packages/setup/bin/murmur.mjs', 'invite', '--data-dir', f.profile, '--out', f.output, ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /synthetic-secret|192\.168\.35\.10/);
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  }
  await f.unchanged();
});
