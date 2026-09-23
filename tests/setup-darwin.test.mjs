import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDarwinAdapter } from '../packages/setup/dist/src/platform/darwin.js';
import { skipPosixServiceHost, skipWithoutSymlinks } from './windows-host.mjs';

const missing = { code: 113, stdout: '', stderr: 'Could not find service in domain for user gui: 501' };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
async function fixture(t, runner) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-darwin-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'a & b repo');
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'scripts', 'murmur-daemon.mjs'), '');
  const dataDir = path.join(home, 'profile');
  const ctx = { dataDir, configPath: path.join(dataDir, 'agent-config.json'), storePath: path.join(dataDir, 'murmur.db'), repoRoot: root, nodePath: process.execPath, logDir: path.join(dataDir, 'logs'), serviceName: 'org.murmur.adapter-test' };
  const calls = [];
  const run = async (file, args) => { calls.push([file, args]); return runner ? runner(file, args, ctx, home) : missing; };
  const adapter = createDarwinAdapter({ homeDir: home, uid: 501, env: { PATH: '' }, executableDirs: [], applicationDirs: [path.join(home, 'Applications')], run });
  const plist = path.join(home, 'Library', 'LaunchAgents', ctx.serviceName + '.plist');
  return { adapter, home, ctx, calls, plist };
}

test('install produces private escaped plist, stays unloaded and is idempotent', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t);
  await f.adapter.install(f.ctx);
  const initial = await fs.readFile(f.plist, 'utf8');
  assert.match(initial, /a &amp; b repo/);
  assert.match(initial, /<key>ProgramArguments<\/key><array><string>\//);
  assert.match(initial, /<key>DATA_DIR<\/key>/);
  assert.equal((await fs.stat(f.plist)).mode & 0o777, 0o600);
  const before = await fs.stat(f.plist);
  await f.adapter.install(f.ctx);
  assert.equal((await fs.stat(f.plist)).mtimeMs, before.mtimeMs);
  assert.ok(f.calls.every(([, args]) => args[0] === 'print'));
});

test('install backs up only an owned changed plist', async t => {
  const f = await fixture(t); await f.adapter.install(f.ctx);
  const original = await fs.readFile(f.plist, 'utf8');
  const dataDir = path.join(f.home, 'new profile');
  await f.adapter.install({ ...f.ctx, dataDir, configPath: path.join(dataDir, 'agent-config.json'), storePath: path.join(dataDir, 'murmur.db'), logDir: path.join(dataDir, 'logs') });
  const backups = (await fs.readdir(path.dirname(f.plist))).filter(n => n.includes('.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(f.plist), backups[0]), 'utf8'), original);
});

test('install refuses an unmanaged plist', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.plist), { recursive: true });
  await fs.writeFile(f.plist, '<plist>some other service</plist>');
  await assert.rejects(f.adapter.install(f.ctx), /unmanaged/);
});
test('install refuses a symlinked plist', { skip: skipWithoutSymlinks }, async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.plist), { recursive: true });
  const target = path.join(f.home, 'unrelated'); await fs.writeFile(target, 'do not change');
  await fs.symlink(target, f.plist);
  await assert.rejects(f.adapter.install(f.ctx), /nonregular/);
  assert.equal(await fs.readFile(target, 'utf8'), 'do not change');
});

test('install refuses updating a loaded label and inconclusive launchctl errors', async t => {
  for (const output of [ok('state = running'), { code: 1, stdout: '', stderr: 'Operation not permitted' }]) {
    const f = await fixture(t, () => output);
    await assert.rejects(f.adapter.install(f.ctx), /stop-service|cannot-confirm/);
    assert.equal(await fs.stat(f.plist).then(() => true, () => false), false);
  }
});

test('reject relative paths, control characters, traversal and misleading store path before commands', async t => {
  const f = await fixture(t);
  for (const patch of [{ logDir: 'relative' }, { logDir: '/tmp/legacy-logs' }, { serviceName: '../other' }, { nodePath: '/tmp/node\nBAD' }, { storePath: '/tmp/wrong.db' }, { configPath: '/tmp/other.json' }, { dataDir: '/tmp/../profile' }]) {
    await assert.rejects(f.adapter.install({ ...f.ctx, ...patch }), /darwin-invalid|path-contract-mismatch/);
  }
  assert.equal(f.calls.length, 0);
});

test('status distinguishes absent service from unreadable service without leaking stderr', async t => {
  const f = await fixture(t);
  assert.equal((await f.adapter.status(f.ctx)).state, 'stopped');
  const denied = await fixture(t, () => ({ code: 1, stdout: '', stderr: 'token=SECRET permission denied' }));
  const value = await denied.adapter.status(denied.ctx);
  assert.equal(value.state, 'unknown');
  assert.ok(!JSON.stringify(value).includes('SECRET'));
});

test('running state reports actual FD store evidence and start time', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t, (file, args, ctx, home) => {
    if (file === '/bin/launchctl') return ok(`path = ${path.join(home, 'Library', 'LaunchAgents', ctx.serviceName + '.plist')}\n state = running\n pid = 123\n last exit code = 0\n`);
    if (file === '/bin/ps') return ok('Sat Sep 19 12:00:00 2026\n');
    if (file === '/usr/sbin/lsof') return ok(`p123\nn${ctx.storePath}\n`);
    throw new Error('unexpected command');
  });
  await fs.mkdir(f.ctx.dataDir); await fs.writeFile(f.ctx.storePath, 'test');
  const value = await f.adapter.status(f.ctx);
  assert.equal(value.state, 'running'); assert.equal(value.pid, 123);
  assert.equal(value.since, '2026-09-19T12:00:00.000Z');
  assert.equal(value.observedStorePath, await fs.realpath(f.ctx.storePath));
});

test('environment claim does not prove observed store path', async t => {
  const f = await fixture(t, (file, args, ctx, home) => file === '/bin/launchctl'
    ? ok(`path = ${path.join(home, 'Library', 'LaunchAgents', ctx.serviceName + '.plist')}\n state = running\n pid = 123\n MURMUR_STORE_PATH => ${ctx.storePath}`)
    : file === '/usr/sbin/lsof' ? ok('p123\nn/some/other/db\n') : ok());
  await fs.mkdir(f.ctx.dataDir); await fs.writeFile(f.ctx.storePath, 'test');
  assert.equal((await f.adapter.status(f.ctx)).observedStorePath, null);
});

test('nonzero exited service is failed, unrecognized state stays unknown', async t => {
  for (const [state, exit, expected] of [['waiting', 7, 'failed'], ['waiting', 0, 'stopped'], ['invented', 0, 'unknown']]) {
    const f = await fixture(t, (file, args, ctx, home) => ok(`path = ${path.join(home, 'Library', 'LaunchAgents', ctx.serviceName + '.plist')}\n state = ${state}\n last exit code = ${exit}\n`));
    assert.equal((await f.adapter.status(f.ctx)).state, expected);
  }
});

test('start bootstraps by argv then kickstarts without killing; stop bootouts idempotently', async t => {
  let loaded = false;
  const f = await fixture(t, (file, args, ctx, home) => {
    if (args[0] === 'print') return loaded ? ok(`path = ${path.join(home, 'Library', 'LaunchAgents', ctx.serviceName + '.plist')}\n state = running\n pid = 123\n`) : missing;
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    return ok();
  });
  await f.adapter.install(f.ctx); await f.adapter.start(f.ctx); await f.adapter.start(f.ctx);
  await f.adapter.stop(f.ctx); await f.adapter.stop(f.ctx);
  const actions = f.calls.filter(([, args]) => args[0] !== 'print');
  assert.deepEqual(actions, [
    ['/bin/launchctl', ['bootstrap', 'gui/501', f.plist]],
    ['/bin/launchctl', ['kickstart', 'gui/501/org.murmur.adapter-test']],
    ['/bin/launchctl', ['kickstart', 'gui/501/org.murmur.adapter-test']],
    ['/bin/launchctl', ['bootout', 'gui/501/org.murmur.adapter-test']],
  ]);
});

test('never operates an unrelated loaded service sharing the requested label', async t => {
  const f = await fixture(t);
  await f.adapter.install(f.ctx);
  const other = createDarwinAdapter({ homeDir: f.home, uid: 501, run: async () => ok('path = /other/service.plist\nstate = running') });
  assert.equal((await other.status(f.ctx)).state, 'unknown');
  await assert.rejects(other.start(f.ctx), /other-loaded-service/);
  await assert.rejects(other.stop(f.ctx), /other-loaded-service/);
});

test('client detection uses executable permission and desktop bundle IDs; never writes config', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t);
  const bin = path.join(f.home, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'codex'), 'not executable', { mode: 0o600 });
  const apps = path.join(f.home, 'Applications');
  for (const name of ['Claude.app', 'ChatGPT.app']) {
    await fs.mkdir(path.join(apps, name, 'Contents'), { recursive: true });
    await fs.writeFile(path.join(apps, name, 'Contents', 'Info.plist'), 'fixture');
  }
  const adapter = createDarwinAdapter({ homeDir: f.home, uid: 501, applicationDirs: [apps], executableDirs: [bin], env: { PATH: `${bin}:.:`, CODEX_HOME: path.join(f.home, 'custom codex') }, run: async (file, args) => ok(args.at(-1).includes('Claude.app') ? 'com.anthropic.claudefordesktop\n' : 'com.openai.codex\n') });
  const detections = await adapter.detectClients(f.ctx);
  assert.deepEqual(detections.map(x => x.installed), [true, true, false, true]);
  assert.equal(detections[2].configPath, path.join(f.home, 'custom codex', 'config.toml'));
  assert.equal(detections[0].configPath, path.join(f.home, '.claude.json'));
  assert.equal(await fs.stat(detections[0].configPath).then(() => true, () => false), false);
});

test('classic ChatGPT application is not mistaken for Codex', async t => {
  const f = await fixture(t);
  const apps = path.join(f.home, 'Applications');
  await fs.mkdir(path.join(apps, 'ChatGPT.app', 'Contents'), { recursive: true });
  await fs.writeFile(path.join(apps, 'ChatGPT.app', 'Contents', 'Info.plist'), 'fixture');
  const adapter = createDarwinAdapter({ homeDir: f.home, uid: 501, env: { PATH: '', CODEX_HOME: 'relative' }, executableDirs: [], applicationDirs: [apps], run: async () => ok('com.openai.chat\n') });
  const result = await adapter.detectClients(f.ctx);
  assert.equal(result[3].installed, false); assert.equal(result[3].configPath, null);
});

test('custom Claude profile remains explicit unknown, and an executable directory is not a CLI', async t => {
  const f = await fixture(t);
  const bin = path.join(f.home, 'bin');
  await fs.mkdir(path.join(bin, 'codex'), { recursive: true });
  const adapter = createDarwinAdapter({ homeDir: f.home, uid: 501, env: { PATH: bin, CLAUDE_CONFIG_DIR: '/custom profile' }, executableDirs: [bin], applicationDirs: [] });
  const clients = await adapter.detectClients(f.ctx);
  assert.equal(clients[0].configPath, null); assert.match(clients[0].detail, /verification/);
  assert.equal(clients[2].installed, false);
});

test('stop refuses another profile reusing the same serviceName without any bootout', async t => {
  let loaded = false;
  const f = await fixture(t, (file, args, ctx, home) => loaded
    ? ok(`path = ${path.join(home, 'Library', 'LaunchAgents', ctx.serviceName + '.plist')}\n state = running\n pid = 123\n`)
    : missing);
  await f.adapter.install(f.ctx); loaded = true;
  const dataDir = path.join(f.home, 'unrelated-profile');
  const other = { ...f.ctx, dataDir, configPath: path.join(dataDir, 'agent-config.json'), storePath: path.join(dataDir, 'murmur.db'), logDir: path.join(dataDir, 'logs') };
  await assert.rejects(f.adapter.stop(other), /stop-profile-mismatch/);
  assert.ok(f.calls.every(([, args]) => args[0] !== 'bootout'));
});
