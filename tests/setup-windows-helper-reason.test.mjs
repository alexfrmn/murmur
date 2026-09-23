import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWindowsAdapter, helperReason } from '../packages/setup/dist/src/platform/windows.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';

const context = resolveContext({ platform: 'win32', dataDir: 'C:\\Users\\me\\profile', repoRoot: 'C:\\Program Files\\Murmur\\runtime', nodePath: 'C:\\Program Files\\nodejs\\node.exe', serviceName: 'MurmurFixture' });
const helper = 'C:\\Program Files\\Murmur\\murmur-svc.exe';
const missing = { schema: 'murmur.windows-service/1', serviceName: context.serviceName, manager: 'none', state: 'stopped', profile: null, pid: 0, daemonPid: null,
  since: null, lastExitCode: null, lastFailureAt: null, observedStorePath: null, observedStoreUnknownReason: null, restartCount: null, restartWindowMs: null,
  restartsLastHour: null, restartsUnknownReason: 'service.history-window-incomplete', restartsPerHourLimit: 5 };

test('only a strict last footer line names the helper reason, case preserved', () => {
  const human = 'Daemon PID 4242 did not remain alive; C:\\Users\\Имя\\secret\\agent-config.json rolled back\n';
  assert.equal(helperReason(`${human}murmur-svc: reason=daemon.didNotLive\n`), 'helper.daemon.didNotLive');
  assert.equal(helperReason('murmur-svc: reason=install.rollbackFailed'), 'helper.install.rollbackFailed');
  assert.equal(helperReason('murmur-svc: reason=error.unknown\n'), 'helper.error.unknown');
  for (const stderr of [
    '', human, 'access denied',
    'murmur-svc: reason=daemon.didNotLive\nlater text\n',   // not the last line
    'murmur-svc: reason=daemon.didNotLive\r\n',             // CRLF is not the contract
    'x murmur-svc: reason=daemon.didNotLive\n',             // not a whole line
    'murmur-svc: reason=C:\\Users\\me\n', 'murmur-svc: reason=1bad\n', 'murmur-svc: reason=bad-key\n',
    'murmur-svc: reason=a..b\n', 'murmur-svc: reason=trailing.\n', 'murmur-svc: reason=\n', `murmur-svc: reason=${'a'.repeat(90)}\n`,
  ]) assert.equal(helperReason(stderr), 'helper-command-failed', JSON.stringify(stderr));
});

function adapter(stderr, calls = []) {
  return createWindowsAdapter({ helperPath: helper, canonicalize: async v => path.win32.normalize(v).toLowerCase(), elevated: async () => true,
    run: async (_, args) => { calls.push(args[0]); return args[0] === 'status' ? { code: 0, stdout: JSON.stringify(missing), stderr: '' } : { code: 1, stdout: '', stderr }; } });
}

test('a failed install reports service.helper.<key> and never the helper text', async () => {
  const calls = [];
  const error = await adapter('Daemon PID 4242 did not remain alive at C:\\secret\nmurmur-svc: reason=daemon.didNotLive\n', calls).install(context).then(() => null, e => e);
  assert.equal(error.message, 'service.helper.daemon.didNotLive');
  assert.deepEqual(calls, ['status', 'install']);
  const plain = await adapter('Daemon PID 4242 did not remain alive at C:\\secret\n').install(context).then(() => null, e => e);
  assert.equal(plain.message, 'service.helper-command-failed');
});

test('status keeps a helper reason instead of a generic measurement failure', async () => {
  const failing = createWindowsAdapter({ helperPath: helper, canonicalize: async v => v, elevated: async () => true,
    run: async () => ({ code: 1, stdout: '', stderr: 'could not read C:\\ProgramData\\Murmur\\x.state.json\nmurmur-svc: reason=error.readState\n' }) });
  const s = await failing.status(context);
  assert.equal(s.state, 'unknown'); assert.equal(s.detail, 'service.helper.error.readState');
  assert.ok(!JSON.stringify(s).includes('ProgramData'));
});
