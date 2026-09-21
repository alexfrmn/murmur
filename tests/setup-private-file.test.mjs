import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writePrivateJson } from '../scripts/secure-state.mjs';
import { protectPrivateFile } from '../packages/setup/dist/src/private-file.js';

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
