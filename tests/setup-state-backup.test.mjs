import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeExactBackup } from '../packages/setup/dist/src/state.js';

test('backup refusal never removes an occupied recovery file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'murmur-backup-refusal-'));
  try {
    const occupied = path.join(dir, 'agent-config.backup-occupied.json');
    const original = Buffer.from('existing recovery bytes\n');
    await writeFile(occupied, original, { mode: 0o600 });
    await assert.rejects(writeExactBackup({ dataDir: dir }, occupied, Buffer.from('new bytes')), { code: 'EEXIST' });
    assert.deepEqual(await readFile(occupied), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('new recovery file preserves exact bytes and private POSIX mode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'murmur-backup-exact-'));
  try {
    const target = path.join(dir, 'agent-config.backup-new.json');
    const original = Buffer.from('{ "synthetic": true }  \r\n');
    await writeExactBackup({ dataDir: dir }, target, original);
    assert.deepEqual(await readFile(target), original);
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
