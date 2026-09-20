import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWindowsAdapter } from '../packages/setup/dist/src/platform/windows.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
const context = resolveContext({ platform: 'win32', dataDir: 'C:\\Users\\me\\profile', repoRoot: 'C:\\Program Files\\Murmur\\runtime', nodePath: 'C:\\Program Files\\nodejs\\node.exe', serviceName: 'MurmurFixture' });
const helper = 'C:\\Program Files\\Murmur\\murmur-svc.exe';
const canonicalize = async value => path.win32.normalize(value).toLowerCase();
function native(overrides = {}) {
  return { schema: 'murmur.windows-service/1', serviceName: context.serviceName, manager: 'windows-service', state: 'running',
    profile: { dataDir: context.dataDir, workDir: context.repoRoot, entry: path.win32.join(context.repoRoot, 'scripts', 'murmur-daemon.mjs'), node: context.nodePath, restartsPerHourLimit: 5 },
    pid: 100, daemonPid: 200, since: '2026-09-19T19:00:00Z', lastExitCode: null, lastFailureAt: null,
    observedStorePath: context.storePath, observedStoreUnknownReason: null,
    restartCount: 0, restartWindowMs: 15000, restartsLastHour: null, restartsUnknownReason: 'service.history-window-incomplete', restartsPerHourLimit: 5, ...overrides };
}
function fixture(initial = native()) {
  let value = initial, failure = false; const calls = [];
  const adapter = createWindowsAdapter({ helperPath: helper, canonicalize,
    env: { NODE_OPTIONS: '--require injected.js', DATA_DIR: 'C:\\other', MURMUR_STORE_PATH: 'C:\\wrong.db', ProgramData: 'C:\\ProgramData' },
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (failure) return { code: 1, stdout: '', stderr: 'secret runtime output' };
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(value), stderr: '' };
      if (args[0] === 'stop') value = native({ state: 'stopped', pid: 0, daemonPid: null, observedStorePath: null, restartCount: null, restartWindowMs: null });
      if (args[0] === 'uninstall') value = native({ manager: 'none', state: 'stopped', profile: null, pid: 0, daemonPid: null, observedStorePath: null, restartCount: null, restartWindowMs: null });
      return { code: 0, stdout: 'operation returned', stderr: '' };
    } });
  return { adapter, calls, set: v => { value = v; }, fail: () => { failure = true; } };
}
test('Windows status maps daemon PID and only observed database, preserving actual restart interval', async () => {
  const f = fixture(), s = await f.adapter.status(context);
  assert.equal(s.manager, 'windows-service'); assert.equal(s.state, 'running'); assert.equal(s.pid, 200);
  assert.equal(s.observedStorePath.toLowerCase(), context.storePath.toLowerCase());
  assert.equal(s.restartCount, 0); assert.equal(s.restartWindowMs, 15000);
});
test('missing helper or command failure stays unknown without exposing command output', async () => {
  const f = fixture(); f.fail(); const s = await f.adapter.status(context);
  assert.equal(s.state, 'unknown'); assert.equal(s.pid, null); assert.ok(!JSON.stringify(s).includes('secret'));
});
test('legacy, truncated and contradictory native replies cannot authorize service mutation', async () => {
  const bad = [native({ schema: undefined }), native({ schema: 'murmur.windows-service/2' }), native({ daemonPid: -1 }), native({ restartCount: -1 }), native({ restartWindowMs: 3600001 }), native({ restartsLastHour: 0 }), native({ profile: null }), native({ serviceName: 'OtherService' }), native({ observedStorePath: 'C:\\other\\murmur.db' })];
  for (const value of bad) {
    const f = fixture(value); assert.equal((await f.adapter.status(context)).state, 'unknown');
    await assert.rejects(f.adapter.stop(context)); assert.ok(f.calls.every(c => c.args[0] === 'status'));
  }
});
test('each action pins selected profile and drops ambient Node and store overrides', async () => {
  const f = fixture(); await f.adapter.stop(context);
  assert.deepEqual(f.calls.map(c => c.args[0]), ['status', 'stop', 'status']);
  for (const c of f.calls) {
    assert.equal(c.file, helper); assert.equal(c.options.env.DATA_DIR, context.dataDir);
    assert.equal(c.options.env.MURMUR_DATA_DIR, context.dataDir); assert.equal(c.options.env.MURMUR_SERVICE_NAME, context.serviceName);
    assert.equal(c.options.env.NODE_OPTIONS, undefined); assert.equal(c.options.env.MURMUR_STORE_PATH, undefined);
  }
});
test('wrong profile refuses start stop and uninstall before mutations', async () => {
  for (const key of ['dataDir', 'node', 'entry', 'workDir']) {
    const v = native(); v.profile[key] = 'C:\\another\\profile';
    for (const action of ['start', 'stop', 'uninstall']) {
      const f = fixture(v); await assert.rejects(f.adapter[action](context));
      assert.ok(f.calls.every(c => c.args[0] === 'status'));
    }
  }
});
test('not-installed differs from an inaccessible manager, and uninstall verifies absence', async () => {
  const missing = native({ manager: 'none', state: 'stopped', profile: null, pid: 0, daemonPid: null, observedStorePath: null, restartCount: null, restartWindowMs: null });
  const f = fixture(missing); assert.equal((await f.adapter.status(context)).state, 'stopped');
  await f.adapter.stop(context); assert.ok(f.calls.every(c => c.args[0] === 'status'));
  const running = fixture(); await running.adapter.uninstall(context);
  assert.deepEqual(running.calls.map(c => c.args[0]), ['status', 'uninstall', 'status']);
});
test('helper success without requested state does not report a successful start', async () => {
  const f = fixture(native({ state: 'stopped', pid: 0, daemonPid: null, observedStorePath: null, restartCount: null, restartWindowMs: null }));
  await assert.rejects(f.adapter.start(context), /action-unconfirmed/);
});
test('invalid paths and names fail before any helper call', async () => {
  const f = fixture();
  for (const c of [{ ...context, dataDir: 'relative' }, { ...context, serviceName: '../other' }, { ...context, storePath: 'C:\\other.db' }]) await assert.rejects(f.adapter.start(c));
  assert.equal(f.calls.length, 0);
});

test('canonical DATA_DIR rejects conflict and explicit selection overrides ambient profiles', () => {
  const options = { platform: 'win32', home: 'C:\\Users\\me', repoRoot: context.repoRoot, nodePath: context.nodePath };
  assert.throws(() => resolveContext({ ...options, env: { DATA_DIR: 'C:\\alice', MURMUR_DATA_DIR: 'C:\\bob' } }), /data-dir-conflict/);
  assert.throws(() => resolveContext({ ...options, env: { DATA_DIR: '', MURMUR_DATA_DIR: 'C:\\bob' } }), /data-dir-empty/);
  assert.equal(resolveContext({ ...options, dataDir: context.dataDir, env: { DATA_DIR: 'relative', MURMUR_DATA_DIR: 'other' } }).dataDir, context.dataDir);
});
test('distinct canonical case-sensitive profiles cannot authorize an action', async () => {
  const value = native(); value.profile.dataDir = context.dataDir.replace('profile', 'PROFILE');
  const calls = [];
  const adapter = createWindowsAdapter({ helperPath: helper, canonicalize: async p => p, run: async (_, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify(value), stderr: '' }; } });
  await assert.rejects(adapter.stop(context), /profile-mismatch/);
  assert.equal(calls.length, 1);
});

test('Windows logs refuses to advertise a different configured folder', { skip: process.platform !== 'win32' }, async () => {
  const { main } = await import('../packages/setup/dist/src/cli.js');
  const untouched = new Proxy({}, { get() { throw Error('unexpected-service-access'); } });
  await assert.rejects(main(['logs', 'path', '--data-dir', context.dataDir], untouched), /logs.windows-native-location-unavailable/);
});
