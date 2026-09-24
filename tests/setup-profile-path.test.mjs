import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../packages/setup/dist/src/cli.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';

const runtime = { repoRoot: 'C:\\Murmur\\runtime', nodePath: 'C:\\Program Files\\nodejs\\node.exe' };

test('a trailing separator in the profile path is refused instead of selecting another service', () => {
  for (const dataDir of ['C:\\Users\\Имя Фамилия\\Murmur\\', 'C:/Users/me/Murmur/', 'C:\\Users\\me\\Murmur\\\\']) {
    assert.throws(() => resolveContext({ ...runtime, platform: 'win32', dataDir }), /^Error: profile\.trailing-separator$/, dataDir);
  }
  assert.throws(() => resolveContext({ platform: 'darwin', dataDir: '/Users/me/Murmur/', repoRoot: '/opt/murmur', nodePath: '/usr/bin/node' }), /profile\.trailing-separator/);
  assert.throws(() => resolveContext({ ...runtime, platform: 'win32', env: { DATA_DIR: 'C:\\Users\\me\\Murmur\\' } }), /profile\.trailing-separator/);
});

test('the same profile spelled without the separator keeps its path-derived service name', () => {
  const plain = resolveContext({ ...runtime, platform: 'win32', dataDir: 'C:\\Users\\me\\Murmur' });
  assert.equal(resolveContext({ ...runtime, platform: 'win32', dataDir: 'C:/Users/me/Murmur' }).serviceName, plain.serviceName);
  assert.match(plain.serviceName, /^murmur-[0-9a-f]{12}$/);
});

test('init, join and status name the service that this exact profile path selects', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-profile-path- пробел кириллица-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = { manager: 'none', status: async () => ({ state: 'stopped', manager: 'none', pid: null, since: null, lastExitCode: null, observedStorePath: null, restartCount: null, restartWindowMs: null }) };
  const a = path.join(root, 'agent-a'), b = path.join(root, 'agent-b'), invite = path.join(root, 'invite.txt');
  const name = dir => resolveContext({ dataDir: dir }).serviceName;
  assert.equal((await main(['init', '--agent-id', 'agent-a', '--broker-url', 'nats://server.example.com:4222', '--data-dir', a], adapter)).serviceName, name(a));
  await main(['invite', '--out', invite, '--data-dir', a], adapter);
  assert.equal((await main(['join', '--agent-id', 'agent-b', '--invite-file', invite, '--reply-out', path.join(root, 'reply.txt'), '--data-dir', b], adapter)).serviceName, name(b));
  assert.equal((await main(['status', '--json', '--data-dir', b], adapter)).serviceName, name(b));
  assert.equal((await main(['status', '--json', '--data-dir', b, '--service-name', 'MurmurExplicit'], adapter)).serviceName, 'MurmurExplicit');
  await assert.rejects(main(['status', '--json', '--data-dir', b + path.sep], adapter), /profile\.trailing-separator/);
});
