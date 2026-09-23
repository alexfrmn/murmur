import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { main } from '../packages/setup/dist/src/cli.js';
import { safeError } from '../packages/setup/dist/src/config.js';
import { describeProcess, describeFileAccess } from './ci-windows-diagnostics.mjs';

test('safeError keeps stable codes and hides free-form messages', () => {
  assert.equal(safeError(new Error('onboarding.invalid-blob')), 'onboarding.invalid-blob');
  assert.equal(safeError(new Error('database is locked')), 'database is locked');
  assert.equal(safeError(new Error('token nats-secret leaked here')), 'operation-failed');
  assert.equal(safeError(undefined), 'operation-failed');
});

test('safeError reports errno and syscall of system errors without the path', () => {
  const error = Object.assign(new Error("EPERM: operation not permitted, open 'C:\\Users\\Имя Фамилия\\secret-invite.txt'"), { code: 'EPERM', syscall: 'open' });
  assert.equal(safeError(error), 'system.EPERM:open');
  assert.equal(safeError(Object.assign(new Error('x y'), { code: 'EACCES' })), 'system.EACCES');
  assert.equal(safeError(Object.assign(new Error('x y'), { code: 'not an errno', syscall: 'open' })), 'operation-failed');
  assert.equal(safeError(Object.assign(new Error('x y'), { code: 'EPERM', syscall: 'open C:\\secret' })), 'system.EPERM');
});

async function joinError(root, invite) {
  const args = ['join', '--agent-id', 'agent-b', '--invite-file', invite, '--reply-out', path.join(root, 'reply.txt'), '--data-dir', path.join(root, 'profile')];
  const error = await main(args, { manager: 'none' }).then(() => null, e => e);
  assert.ok(error, 'join must fail');
  await assert.rejects(fs.stat(path.join(root, 'profile')), { code: 'ENOENT' });
  return safeError(error);
}

test('join with a missing invite names the option and the reason', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-safe-error- пробел кириллица-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await joinError(root, path.join(root, 'missing-invite.txt')), 'onboarding.invite-file-not-found');
});

test('join with an unreadable invite reports access denied, not operation-failed', async t => {
  if (process.platform !== 'win32' && process.getuid?.() === 0) return t.skip('root reads any file');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-safe-error- пробел кириллица-'));
  const invite = path.join(root, 'invite.txt');
  await fs.writeFile(invite, 'MURMUR:e30=\n');
  if (process.platform === 'win32') {
    // An explicit Deny read ACE for this user's SID: it comes first in canonical order and binds an
    // elevated administrator too (a grant-only-SYSTEM DACL did not, on the GitHub runner). The owner
    // keeps WRITE_DAC, so /reset works for cleanup.
    const system32 = tool => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
    const sid = /"(S-1-5-[0-9-]+)"\s*$/.exec(spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim())?.[1];
    assert.ok(sid, 'current user SID');
    const lock = spawnSync(system32('icacls.exe'), [invite, '/deny', `*${sid}:(R)`], { encoding: 'utf8' });
    assert.equal(lock.status, 0, lock.stdout + lock.stderr);
    t.after(async () => { spawnSync(system32('icacls.exe'), [invite, '/reset']); await fs.rm(root, { recursive: true, force: true }); });
  } else {
    await fs.chmod(invite, 0);
    t.after(async () => { await fs.chmod(invite, 0o600); await fs.rm(root, { recursive: true, force: true }); });
  }
  await describeProcess(t); await describeFileAccess(t, invite);
  // The fixture must really be unreadable here; an environment that still reads it (for example with
  // the backup privilege enabled) cannot exercise this path and says so instead of passing silently.
  const readable = await fs.readFile(invite).then(() => true, e => (e.code === 'EPERM' || e.code === 'EACCES' ? false : Promise.reject(e)));
  if (readable) return t.skip('this environment can read a file whose DACL denies the current user');
  assert.equal(await joinError(root, invite), 'onboarding.invite-file-access-denied');
});
