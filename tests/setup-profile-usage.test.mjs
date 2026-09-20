import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDarwinAdapter } from '../packages/setup/dist/src/platform/darwin.js';
import { createLinuxAdapter } from '../packages/setup/dist/src/platform/linux.js';

const unixOnly = { skip: typeof process.getuid !== 'function' };

async function contextFixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-profile-usage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'profile');
  const repoRoot = path.join(home, 'repo');
  await fs.mkdir(path.join(dataDir, 'logs'), { recursive: true });
  await fs.chmod(dataDir, 0o700);
  await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'agent-config.json'), '{}');
  await fs.writeFile(path.join(dataDir, 'murmur.db'), 'fixture');
  const context = {
    dataDir,
    configPath: path.join(dataDir, 'agent-config.json'),
    storePath: path.join(dataDir, 'murmur.db'),
    repoRoot,
    nodePath: process.execPath,
    logDir: path.join(dataDir, 'logs'),
    serviceName: 'murmur-profile-usage-test',
  };
  return { home, context };
}

async function fakeProcess(procRoot, pid, uid, targets) {
  const root = path.join(procRoot, String(pid));
  await fs.mkdir(path.join(root, 'fd'), { recursive: true });
  const fields = Array.from({ length: 20 }, (_, index) => index === 0 ? 'S' : index === 19 ? `${pid}00` : '0');
  await fs.writeFile(path.join(root, 'stat'), `${pid} (fixture process) ${fields.join(' ')}\n`);
  const uids = Array.isArray(uid) ? uid : [uid, uid, uid, uid];
  await fs.writeFile(path.join(root, 'status'), `Name:\tfixture\nUid:\t${uids.join('\t')}\n`);
  for (const [index, target] of targets.entries()) await fs.symlink(target, path.join(root, 'fd', String(index)));
}

test('Linux profile usage excludes only itself and reports another same-UID open file', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const procRoot = path.join(home, 'proc');
  await fs.mkdir(path.join(procRoot, String(process.pid), 'fd'), { recursive: true });
  await fs.symlink(context.configPath, path.join(procRoot, String(process.pid), 'fd', '7'));
  const externalAlias = path.join(home, 'store-alias');
  await fs.symlink(context.storePath, externalAlias);
  await fakeProcess(procRoot, 42001, process.getuid(), [externalAlias]);
  const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
});

test('Linux profile usage reports free only after stable process and profile snapshots', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const procRoot = path.join(home, 'proc');
  const outside = path.join(home, 'outside');
  await fs.writeFile(outside, 'fixture');
  await fs.mkdir(path.join(procRoot, String(process.pid)), { recursive: true });
  await fakeProcess(procRoot, 42002, process.getuid(), [outside, 'socket:[123]', 'anon_inode:[eventpoll]']);
  const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'free', reason: 'profile-usage.no-open-files' });
});

test('Linux profile usage includes every real, effective, saved, and filesystem UID', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const selected = process.getuid();
  const foreign = selected === 0 ? 1 : 0;
  for (let index = 0; index < 4; index++) {
    const procRoot = path.join(home, `proc-uid-${index}`); await fs.mkdir(procRoot);
    const uids = [foreign, foreign, foreign, foreign]; uids[index] = selected;
    await fakeProcess(procRoot, 42100 + index, uids, [context.storePath]);
    const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
    assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
  }
});

test('Unix profile usage refuses a permissive profile root without changing it', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const original = await fs.readFile(context.configPath);
  await fs.chmod(context.dataDir, 0o755);
  const procRoot = path.join(home, 'proc-permissive'); await fs.mkdir(procRoot);
  const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'unknown', reason: 'profile-usage.profile-unverifiable' });
  assert.equal((await fs.stat(context.dataDir)).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readFile(context.configPath), original);
});

test('Linux profile usage fails closed for malformed process, deleted profile path, and aliased tree', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  for (const [name, prepare] of [
    ['malformed', async procRoot => {
      const root = path.join(procRoot, '42003');
      await fs.mkdir(path.join(root, 'fd'), { recursive: true });
      await fs.writeFile(path.join(root, 'stat'), 'malformed');
      await fs.writeFile(path.join(root, 'status'), 'Uid: malformed\n');
    }],
    ['deleted', procRoot => fakeProcess(procRoot, 42004, process.getuid(), [`${context.configPath} (deleted)`])],
  ]) {
    const procRoot = path.join(home, `proc-${name}`); await fs.mkdir(procRoot); await prepare(procRoot);
    const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
    assert.equal((await adapter.profileUsage(context)).state, 'unknown');
  }
  await fs.symlink(path.join(home, 'outside'), path.join(context.dataDir, 'alias'));
  const adapter = createLinuxAdapter({ homeDir: home, procDir: path.join(home, 'missing-proc'), env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'unknown', reason: 'profile-usage.profile-unverifiable' });
});

test('Darwin profile usage uses fixed lsof argv and reports another process open file', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const calls = [];
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, run: async (file, args) => {
    calls.push([file, args]);
    return { code: 0, stdout: `p42005\nf3\nn${context.configPath}\n`, stderr: 'lsof: incomplete directory search' };
  } });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
  assert.deepEqual(calls, [['/usr/sbin/lsof', ['-n', '-P', '-Q', '-Fpfn', '+D', context.dataDir]]]);
});

test('Darwin profile usage distinguishes a verified no-match from lsof failure', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const calls = [];
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, run: async (file, args) => {
    calls.push([file, args]);
    return { code: 0, stdout: '', stderr: '' };
  } });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'free', reason: 'profile-usage.no-open-files' });
  assert.deepEqual(calls, [['/usr/sbin/lsof', ['-n', '-P', '-Q', '-Fpfn', '+D', context.dataDir]]]);

  const failed = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, run: async () =>
    ({ code: 1, stdout: '', stderr: '' }) });
  assert.deepEqual(await failed.profileUsage(context), { state: 'unknown', reason: 'profile-usage.probe-unavailable' });
});

test('Darwin profile usage excludes the current PID but refuses warnings and contradictory paths', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const replies = [
    { code: 0, stdout: `p${process.pid}\nfcwd\nn${context.configPath}\n`, stderr: '' },
    { code: 1, stdout: '', stderr: 'lsof: permission denied' },
    { code: 0, stdout: 'p42006\nf3\nn/tmp/outside-profile\n', stderr: '' },
    { code: 0, stdout: 'p42006\nnmissing-file-record\n', stderr: '' },
    { code: 0, stdout: 'p42006\n', stderr: '' },
  ];
  const expected = ['free', 'unknown', 'unknown', 'unknown', 'unknown'];
  for (let index = 0; index < replies.length; index++) {
    const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, run: async () => replies[index] });
    assert.equal((await adapter.profileUsage(context)).state, expected[index]);
  }
});
