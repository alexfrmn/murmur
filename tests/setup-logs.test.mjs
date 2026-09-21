import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createKeyPair, createSigningKeyPair } from '../packages/security/dist/src/index.js';
import { main } from '../packages/setup/dist/src/cli.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Any attempt to observe or mutate a service is a failure for this read-only command.
const noService = new Proxy({}, { get() { throw new Error('unexpected-service-access'); } });
async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-logs-')));
  t.after(async () => {
    await fs.chmod(path.join(home, 'profile', 'logs'), 0o700).catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  });
  const dataDir = path.join(home, 'profile');
  await fs.mkdir(dataDir);
  const config = { agentId: 'logs-agent', subject: 'msg.logs-agent', natsUrl: 'nats://127.0.0.1:1',
    natsToken: 'private-test-token', keys: { encryption: await createKeyPair(), signing: await createSigningKeyPair() }, peers: {} };
  const configPath = path.join(dataDir, 'agent-config.json');
  const bytes = JSON.stringify(config);
  await fs.writeFile(configPath, bytes, { mode: 0o600 });
  const logDir = path.join(dataDir, 'logs');
  const args = ['logs', 'path', '--json', '--data-dir', dataDir, '--service-name', 'logs-test'];
  const run = () => spawnSync(process.execPath, ['packages/setup/bin/murmur.mjs', ...args], { cwd: root, encoding: 'utf8' });
  return { home, dataDir, configPath, bytes, logDir, args, run };
}

test('logs path returns only canonical profile identity and readable configured directory, without writes', { skip: process.platform === 'win32' && 'Windows reports a native logs limitation instead of the POSIX directory contract' }, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.logDir);
  // Opening the directory must not require reading any log contents.
  const log = path.join(f.logDir, 'daemon.log');
  await fs.writeFile(log, 'private-log-content', { mode: 0o000 });
  const expected = { schema: 'murmur.logs/1', agentId: 'logs-agent', dataDir: f.dataDir,
    serviceName: 'logs-test', logDir: f.logDir, source: 'configured' };
  assert.deepEqual(await main(f.args, noService), expected);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.doesNotMatch(result.stdout + result.stderr, /private-test-token|private-log-content|privateKey/);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), f.bytes);
  assert.deepEqual((await fs.readdir(f.dataDir)).sort(), ['agent-config.json', 'logs']);
  assert.deepEqual(await fs.readdir(f.logDir), ['daemon.log']);
});

test('logs path fails clearly when directory is missing and never creates it or a profile', { skip: process.platform === 'win32' && 'Windows reports a native logs limitation instead of the POSIX directory contract' }, async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^logs.directory-missing$/m);
  assert.deepEqual(await fs.readdir(f.dataDir), ['agent-config.json']);
  await fs.rm(f.dataDir, { recursive: true });
  await assert.rejects(main(f.args, noService), /config.missing/);
  await assert.rejects(fs.stat(f.dataDir), { code: 'ENOENT' });
});

test('logs path rejects a regular file without changing its contents', { skip: process.platform === 'win32' && 'Windows reports a native logs limitation instead of the POSIX directory contract' }, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.logDir, 'do-not-replace');
  await assert.rejects(main(f.args, noService), /logs.not-directory/);
  assert.equal(await fs.readFile(f.logDir, 'utf8'), 'do-not-replace');
});

test('logs path rejects links outside the chosen profile and links back to the profile root', { skip: process.platform === 'win32' && 'Windows reports a native logs limitation instead of the POSIX directory contract' }, async t => {
  const f = await fixture(t), outside = path.join(f.home, 'profile-other');
  await fs.mkdir(outside);
  for (const target of [outside, f.dataDir]) {
    await fs.symlink(target, f.logDir, 'junction');
    await assert.rejects(main(f.args, noService), /logs.path-outside-profile/);
    await fs.unlink(f.logDir);
  }
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), f.bytes);
});

test('logs path resolves profile aliases and accepts a directory alias contained inside the profile', { skip: process.platform === 'win32' && 'Windows reports a native logs limitation instead of the POSIX directory contract' }, async t => {
  const f = await fixture(t), actualLogs = path.join(f.dataDir, 'actual-logs'), alias = path.join(f.home, 'alias');
  await fs.mkdir(actualLogs);
  await fs.symlink(actualLogs, f.logDir, 'junction');
  await fs.symlink(f.dataDir, alias, 'junction');
  const result = await main(['logs', 'path', '--data-dir', alias, '--service-name', 'alias-test'], noService);
  assert.equal(result.dataDir, f.dataDir);
  assert.equal(result.logDir, actualLogs);
  assert.equal(result.agentId, 'logs-agent');
  assert.equal(result.serviceName, 'alias-test');
});

test('logs path refuses unreadable or non-traversable directories without changing permissions', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('POSIX permission denial requires a non-root user'); return; }
  const f = await fixture(t);
  await fs.mkdir(f.logDir);
  for (const mode of [0o000, 0o400, 0o100]) {
    await fs.chmod(f.logDir, mode);
    await assert.rejects(main(f.args, noService), /logs.directory-unreadable/);
    assert.equal((await fs.stat(f.logDir)).mode & 0o777, mode);
  }
});

test('logs path does not advertise a directory when profile identity is invalid', { skip: process.platform === 'win32' && 'Windows reports a native logs limitation instead of the POSIX directory contract' }, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.logDir);
  await fs.writeFile(f.configPath, JSON.stringify({ privateKey: 'do-not-print' }));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^config.identity-invalid$/m);
  assert.doesNotMatch(result.stderr, /do-not-print/);
});


test('Windows logs command reports its native limitation without creating or changing profile files', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  for (const directoryExists of [false, true]) {
    if (directoryExists) await fs.mkdir(f.logDir);
    const before = await fs.readdir(f.dataDir);
    await assert.rejects(main(f.args, noService), /^Error: logs\.windows-native-location-unavailable$/);
    const result = f.run();
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^logs\.windows-native-location-unavailable$/m);
    assert.doesNotMatch(result.stderr, /private-test-token|privateKey/);
    assert.equal(await fs.readFile(f.configPath, 'utf8'), f.bytes);
    assert.deepEqual(await fs.readdir(f.dataDir), before);
  }
});
