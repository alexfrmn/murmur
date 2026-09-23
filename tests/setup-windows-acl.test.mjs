import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { main } from '../packages/setup/dist/src/cli.js';

const windows = process.platform === 'win32';
const system32 = tool => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
const AUTHENTICATED_USERS = 'S-1-5-11', USERS = 'S-1-5-32-545', SYSTEM = 'S-1-5-18';
// SID|inherited for every ACE; the path goes through the environment so spaces/Cyrillic need no quoting.
const aces = target => execFileSync(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
  "(Get-Acl -LiteralPath $env:MURMUR_ACL_PATH).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + '|' + $_.IsInherited }"],
// A PowerShell 7 parent leaks its PSModulePath, and Windows PowerShell 5.1 then cannot load Get-Acl.
{ encoding: 'utf8', env: { ...process.env, PSModulePath: undefined, MURMUR_ACL_PATH: target } }).trim().split(/\r?\n/).filter(Boolean);
const userSid = () => /"(S-1-5-[0-9-]+)"\s*$/.exec(execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim())[1];

/** A parent like a fresh folder on a non-system drive: Authenticated Users modify, Users read, inherited. */
async function broadParent(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-acl- пробел кириллица-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync(system32('icacls.exe'), [root, '/grant', `*${AUTHENTICATED_USERS}:(OI)(CI)(M)`, `*${USERS}:(OI)(CI)(RX)`]);
  await fs.writeFile(path.join(root, 'token.txt'), 'test-token-not-a-secret');
  const probe = path.join(root, 'probe.txt'); await fs.writeFile(probe, '');
  assert.ok(aces(probe).some(a => a.startsWith(`${AUTHENTICATED_USERS}|`)), 'fixture parent must hand broad access to new files');
  return root;
}
const initArgs = root => ['init', '--agent-id', 'agent-a', '--broker-url', 'nats://127.0.0.1:4222', '--token-file', path.join(root, 'token.txt'), '--data-dir', path.join(root, 'agent-a')];
function assertOwnerOnly(target) {
  const actual = aces(target);
  for (const broad of [AUTHENTICATED_USERS, USERS]) assert.ok(!actual.some(a => a.startsWith(`${broad}|`)), `${path.basename(target)} grants ${broad}: ${actual}`);
  // The profile directory and the output files are protected; a file inside the profile inherits exactly that.
  const own = target.endsWith('agent-config.json') ? actual.map(a => a.replace(/\|True$/, '|False')) : actual;
  assert.deepEqual([...new Set(own)].sort(), [`${userSid()}|False`, `${SYSTEM}|False`].sort(), `${path.basename(target)}: ${actual}`);
}

test('new profiles and invite/reply files get a protected DACL for the current user and SYSTEM only', { skip: !windows && 'Windows DACL' }, async t => {
  const root = await broadParent(t), invite = path.join(root, 'invite.txt'), reply = path.join(root, 'reply.txt');
  const command = (id, args) => main([...args, '--data-dir', path.join(root, id)], { manager: 'none' });
  await main(initArgs(root), { manager: 'none' });
  await command('agent-a', ['invite', '--out', invite]);
  await command('agent-b', ['join', '--agent-id', 'agent-b', '--invite-file', invite, '--reply-out', reply]);
  for (const target of [path.join(root, 'agent-a'), path.join(root, 'agent-a', 'agent-config.json'), invite,
    path.join(root, 'agent-b'), path.join(root, 'agent-b', 'agent-config.json'), reply]) assertOwnerOnly(target);
});

test('an existing profile directory keeps the ACL its owner chose', { skip: !windows && 'Windows DACL' }, async t => {
  const root = await broadParent(t), profile = path.join(root, 'agent-a');
  await fs.mkdir(profile);
  const before = aces(profile);
  await main(initArgs(root), { manager: 'none' });
  assert.deepEqual(aces(profile), before);
});

test('icacls and whoami planted earlier in PATH are not the ones that run', { skip: !windows && 'Windows DACL' }, async t => {
  const root = await broadParent(t), fake = path.join(root, 'fake-bin');
  await fs.mkdir(fake);
  // hostname.exe exits 0 and prints no SID: run instead of the real tools, it would leave the broad DACL in place.
  for (const tool of ['icacls.exe', 'whoami.exe']) await fs.copyFile(system32('hostname.exe'), path.join(fake, tool));
  const cli = new URL('../packages/setup/dist/src/cli.js', import.meta.url).href;
  const script = `const { main } = await import(${JSON.stringify(cli)}); await main(${JSON.stringify(initArgs(root))}, { manager: 'none' });`;
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'Path';
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8',
    env: { ...process.env, [pathKey]: `${fake};${process.env[pathKey]}`, NODE_NO_WARNINGS: '1' } });
  assert.equal(run.status, 0, run.stderr);
  assertOwnerOnly(path.join(root, 'agent-a'));
  assertOwnerOnly(path.join(root, 'agent-a', 'agent-config.json'));
});
