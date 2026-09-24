import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../packages/setup/dist/src/cli.js';

// MSIX virtualization cannot be switched on in a test. A directory junction reproduces what the
// packaged process sees: %LOCALAPPDATA%\X and Packages\<pkg>\LocalCache\Local\X are one directory.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-msix- пробел кириллица-'));
  const local = path.join(root, 'AppData', 'Local'), roaming = path.join(root, 'AppData', 'Roaming');
  const cache = path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local');
  await fs.mkdir(cache, { recursive: true }); await fs.mkdir(roaming, { recursive: true });
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };
  process.env.LOCALAPPDATA = local; process.env.APPDATA = roaming;
  t.after(async () => { Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true }); });
  const invite = path.join(root, 'invite.txt');
  await main(['init', '--agent-id', 'agent-a', '--broker-url', 'nats://server.example.com:4222', '--data-dir', path.join(root, 'agent-a')], { manager: 'none' });
  await main(['invite', '--out', invite, '--data-dir', path.join(root, 'agent-a')], { manager: 'none' });
  const join = dataDir => main(['join', '--agent-id', 'agent-b', '--invite-file', invite, '--reply-out', path.join(root, `reply-${path.basename(dataDir)}.txt`), '--data-dir', dataDir], { manager: 'none' });
  return { root, local, cache, join };
}
const virtualize = async (f, name) => {
  await fs.mkdir(path.join(f.cache, name));
  await fs.symlink(path.join(f.cache, name), path.join(f.local, name), 'junction');
};

test('join refuses a profile that lives in a package LocalCache twin and writes nothing', { skip: process.platform !== 'win32' && 'MSIX is Windows only' }, async t => {
  const f = await fixture(t); await virtualize(f, 'Murmur-codex-win');
  await assert.rejects(f.join(path.join(f.local, 'Murmur-codex-win')), /^Error: profile\.virtualized-appdata$/);
  assert.deepEqual(await fs.readdir(path.join(f.cache, 'Murmur-codex-win')), []);
  await assert.rejects(fs.stat(path.join(f.root, 'reply-Murmur-codex-win.txt')), { code: 'ENOENT' });
});

test('a new profile below a virtualized folder is refused before it is created', { skip: process.platform !== 'win32' && 'MSIX is Windows only' }, async t => {
  const f = await fixture(t); await virtualize(f, 'Programs');
  await assert.rejects(f.join(path.join(f.local, 'Programs', 'Murmur')), /profile\.virtualized-appdata/);
  assert.deepEqual(await fs.readdir(path.join(f.cache, 'Programs')), []);
});

test('an unrelated leftover twin and a fresh AppData profile are not refused, and no probe is left', { skip: process.platform !== 'win32' && 'MSIX is Windows only' }, async t => {
  const f = await fixture(t);
  // Another app's virtualized copy of the same name is a different directory for this process.
  await fs.mkdir(path.join(f.cache, 'Murmur-real')); await fs.mkdir(path.join(f.local, 'Murmur-real'));
  assert.equal((await f.join(path.join(f.local, 'Murmur-real'))).agentId, 'agent-b');
  assert.equal((await f.join(path.join(f.local, 'Murmur-new'))).agentId, 'agent-b');
  assert.ok(!(await fs.readdir(f.local)).some(n => n.startsWith('.murmur-appdata-probe-')));
  // Outside AppData nothing is probed at all.
  assert.equal((await f.join(path.join(f.root, 'Murmur-outside'))).agentId, 'agent-b');
});
