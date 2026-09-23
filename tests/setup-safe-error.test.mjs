import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../packages/setup/dist/src/cli.js';
import { safeError } from '../packages/setup/dist/src/config.js';

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

test('join with an unreadable invite names the failing system call instead of operation-failed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-safe-error- пробел кириллица-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = path.join(root, 'missing-invite.txt');
  const error = await main(['join', '--agent-id', 'agent-b', '--invite-file', missing, '--reply-out', path.join(root, 'reply.txt'), '--data-dir', path.join(root, 'profile')], { manager: 'none' }).then(() => null, e => e);
  assert.ok(error, 'join must fail');
  assert.equal(safeError(error), 'system.ENOENT:open');
  assert.ok(!safeError(error).includes(root));
  await assert.rejects(fs.stat(path.join(root, 'profile')), { code: 'ENOENT' });
});
