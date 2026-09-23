import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { main } from '../packages/setup/dist/src/cli.js';

const windows = process.platform === 'win32';
// SID|inherited for every ACE; the path goes through the environment so spaces/Cyrillic need no quoting.
const aces = target => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "(Get-Acl -LiteralPath $env:MURMUR_ACL_PATH).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + '|' + $_.IsInherited }"],
// A PowerShell 7 parent leaks its PSModulePath, and Windows PowerShell 5.1 then cannot load Get-Acl.
{ encoding: 'utf8', env: { ...process.env, PSModulePath: undefined, MURMUR_ACL_PATH: target } }).trim().split(/\r?\n/).filter(Boolean);
const userSid = () => /"(S-1-5-[0-9-]+)"\s*$/.exec(execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim())[1];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-acl- пробел кириллица-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = (id, args) => main([...args, '--data-dir', path.join(root, id)], { manager: 'none' });
  await fs.writeFile(path.join(root, 'token.txt'), 'test-token-not-a-secret');
  return { root, command };
}

test('new profiles and invite/reply files get a protected DACL for the current user and SYSTEM only', { skip: !windows && 'Windows DACL' }, async t => {
  const f = await fixture(t), invite = path.join(f.root, 'invite.txt'), reply = path.join(f.root, 'reply.txt');
  await f.command('agent-a', ['init', '--agent-id', 'agent-a', '--broker-url', 'nats://127.0.0.1:4222', '--token-file', path.join(f.root, 'token.txt')]);
  await f.command('agent-a', ['invite', '--out', invite]);
  await f.command('agent-b', ['join', '--agent-id', 'agent-b', '--invite-file', invite, '--reply-out', reply]);
  const expected = [`${userSid()}|False`, 'S-1-5-18|False'].sort();
  for (const target of [path.join(f.root, 'agent-a'), path.join(f.root, 'agent-a', 'agent-config.json'), invite,
    path.join(f.root, 'agent-b'), path.join(f.root, 'agent-b', 'agent-config.json'), reply]) {
    const actual = aces(target);
    // A child of the protected profile directory inherits exactly the same two principals.
    const normalized = target.endsWith('agent-config.json') ? actual.map(a => a.replace(/\|True$/, '|False')) : actual;
    assert.deepEqual([...new Set(normalized)].sort(), expected, `${path.basename(target)}: ${actual.join(', ')}`);
  }
});

test('an existing profile directory keeps the ACL its owner chose', { skip: !windows && 'Windows DACL' }, async t => {
  const f = await fixture(t), profile = path.join(f.root, 'agent-a');
  await fs.mkdir(profile);
  const before = aces(profile);
  await f.command('agent-a', ['init', '--agent-id', 'agent-a', '--broker-url', 'nats://127.0.0.1:4222']);
  assert.deepEqual(aces(profile), before);
});
