import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createLinuxAdapter, renderLinuxUnit } from '../packages/setup/dist/src/platform/linux.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { skipPosixServiceHost } from './windows-host.mjs';
async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-systemd-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const context = resolveContext({ dataDir: path.join(home, 'data'), repoRoot: path.join(home, 'repo'), serviceName: 'murmur-test' });
  const target = path.join(home, '.config/systemd/user/murmur-test.service'), calls = [];
  let info = 'LoadState=not-found\n';
  const adapter = createLinuxAdapter({ homeDir: home, env: { PATH: '' }, procDir: path.join(home, 'proc'), run: async args => { calls.push(args); return args[0] === 'show' ? info : ''; } });
  const loaded = (state = 'inactive') => { info = `LoadState=loaded\nFragmentPath=${target}\nActiveState=${state}\nSubState=${state === 'active' ? 'running' : 'dead'}\nMainPID=123\nExecMainStatus=0\n`; };
  return { home, context, target, adapter, calls, loaded, setInfo: value => { info = value; } };
}
test('install backs up owned changes, refuses loaded updates and is idempotent', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t); await f.adapter.install(f.context); f.loaded();
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(f.target, 'utf8'), renderLinuxUnit(f.context));
  await f.adapter.install(f.context);
  assert.equal((await fs.readdir(path.dirname(f.target))).length, 1);
  f.loaded('active'); const changed = { ...f.context, nodePath: '/different/node' };
  await assert.rejects(f.adapter.install(changed), /stop-before-update/);
  f.loaded(); await f.adapter.install(changed);
  assert.equal((await fs.readdir(path.dirname(f.target))).filter(x => x.includes('.backup-')).length, 1);
});
test('foreign files and symlinks are never replaced', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.target), { recursive: true });
  await fs.writeFile(f.target, 'foreign'); await assert.rejects(f.adapter.install(f.context), /unmanaged/);
  await fs.unlink(f.target); await fs.symlink('/dev/null', f.target);
  await assert.rejects(f.adapter.install(f.context));
  assert.ok((await fs.lstat(f.target)).isSymbolicLink());
});
test('same label cannot start or stop a different contour', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t); await f.adapter.install(f.context); f.loaded();
  const other = resolveContext({ dataDir: path.join(f.home, 'other'), repoRoot: f.context.repoRoot, serviceName: f.context.serviceName });
  for (const action of ['start', 'stop']) await assert.rejects(f.adapter[action](other), /profile-mismatch/);
  assert.ok(f.calls.every(args => !['start', 'stop'].includes(args[0])));
  f.setInfo('LoadState=loaded\nFragmentPath=/etc/systemd/system/unrelated.service\nActiveState=active\n');
  await assert.rejects(f.adapter.install(f.context), /foreign-loaded-unit/);
  assert.equal((await f.adapter.status(f.context)).state, 'unknown');
});
test('status requires actual descriptor evidence, keeps lifetime restart count unmeasured', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t); await f.adapter.install(f.context); f.loaded('active');
  await fs.writeFile(f.context.storePath, 'fixture');
  const fd = path.join(f.home, 'proc/123/fd'); await fs.mkdir(fd, { recursive: true });
  assert.equal((await f.adapter.status(f.context)).observedStorePath, null);
  await fs.symlink(f.context.storePath, path.join(fd, '9'));
  const s = await f.adapter.status(f.context); assert.equal(s.observedStorePath, f.context.storePath);
  assert.equal(s.restartCount, null); assert.equal(s.restartWindowMs, null);
});
test('service operations reject controls and conflicting derived paths before commands', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.install({ ...f.context, dataDir: '/tmp/a\nEnvironment=BAD' }), /invalid-path/);
  await assert.rejects(f.adapter.start({ ...f.context, logDir: '/tmp/other' }), /conflicting-store/);
  assert.equal(f.calls.length, 0);
});
test('unit escaping keeps environment dollars literal and ExecStart dollars escaped', { skip: skipPosixServiceHost }, async t => {
  const f = await fixture(t);
  const c = { ...f.context, repoRoot: '/tmp/a $HOME 100% "quoted"' };
  const text = renderLinuxUnit(c);
  assert.ok(text.includes('$$HOME')); assert.ok(text.includes('100%%'));
  assert.ok(text.includes('StandardOutput=append:'));
});
test('installed systemd parser accepts the generated unit', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  // Parse using the installed systemd verifier, without installing/starting any service.
  const file = path.join(f.home, 'verify.service');
  await fs.writeFile(file, renderLinuxUnit({ ...f.context, repoRoot: f.home }));
  execFileSync('systemd-analyze', ['verify', file], { stdio: 'pipe' });
});
