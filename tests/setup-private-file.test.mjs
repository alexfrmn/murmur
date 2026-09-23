import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writePrivateJson } from '../scripts/secure-state.mjs';
import { protectPrivateFile, preparePrivateReplacement } from '../packages/setup/dist/src/private-file.js';
import { assertPrivateFile, fileAccessPolicy, addExplicitAccessFixture } from './helpers/private-files.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-private-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  await fs.writeFile(file, '{"original":true}\n');
  return { root, file };
}

test('permission preparation failure cannot write secrets or replace the old state', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file);
  await assert.rejects(writePrivateJson(f.file, { secret: 'must-not-write' }, { beforeWrite: async (temporary, handle) => {
    assert.equal((await handle.stat()).size, 0);
    assert.notEqual(temporary, f.file);
    throw new Error('fixture-permission-denied');
  } }), /fixture-permission-denied/);
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.deepEqual(await fs.readdir(f.root), ['state.json']);
});

test('Windows ACL tool failure is closed and does not fall back to POSIX mode', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), before = await fs.readFile(f.file), previous = process.env.SystemRoot;
  process.env.SystemRoot = path.join(f.root, 'missing-windows');
  try {
    await assert.rejects(writePrivateJson(f.file, { secret: 'must-not-write' }, { beforeWrite: protectPrivateFile }), /private-file.windows-acl-failed/);
  } finally {
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
  }
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.deepEqual(await fs.readdir(f.root), ['state.json']);
});

test('Windows private files ignore incompatible inherited PowerShell module paths', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), previous = process.env.PSModulePath;
  const modules = path.join(f.root, 'foreign-modules');
  const security = path.join(modules, 'Microsoft.PowerShell.Security');
  await fs.mkdir(security, { recursive: true });
  await fs.writeFile(path.join(security, 'Microsoft.PowerShell.Security.psm1'), 'throw "foreign-module-loaded"');
  process.env.PSModulePath = modules;
  try {
    await writePrivateJson(f.file, { secret: 'fixture-secret' }, { beforeWrite: protectPrivateFile });
    await assertPrivateFile(f.file);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { secret: 'fixture-secret' });
    assert.equal(process.env.PSModulePath, modules, 'only the child process module path may change');
  } finally {
    if (previous === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previous;
  }
});

for (const explicit of [false, true]) test(`Windows replacement preserves ${explicit ? 'protected explicit readers and deny entries' : 'inherited access'} before writing`, { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), temporary = path.join(f.root, 'replacement.tmp');
  if (explicit) await addExplicitAccessFixture(f.file);
  const before = await fileAccessPolicy(f.file), handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await preparePrivateReplacement(temporary, handle, f.file).catch(async error => {
      // These are only test-owned, empty/synthetic files, never a real profile.
      t.diagnostic(JSON.stringify({ sourceAcl: await fileAccessPolicy(f.file), temporaryAcl: await fileAccessPolicy(temporary) }));
      throw error;
    });
    assert.equal(await fileAccessPolicy(temporary), before);
    assert.equal(await fileAccessPolicy(f.file), before);
    assert.equal((await handle.stat()).size, 0);
  } finally { await handle.close(); }
});
