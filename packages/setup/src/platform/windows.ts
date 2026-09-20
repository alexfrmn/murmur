import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ClientDetection, PlatformAdapter, ProfileUsageSnapshot, ServiceContext, ServiceSnapshot } from '../types.js';

const paths = path.win32;
export interface WindowsOptions {
  helperPath?: string; env?: NodeJS.ProcessEnv; homeDir?: string;
  canonicalize?: (value: string) => Promise<string>;
  run?: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
}
const fail = (reason: string): never => { throw new Error(`service.${reason}`); };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const textOrNull = (v: unknown) => v === null || typeof v === 'string';
const usageUnknown = (): ProfileUsageSnapshot => ({ state: 'unknown', reason: 'profile.probe-unavailable' });
const profileUsageReasons = new Map<string, ProfileUsageSnapshot['state']>([
  ['profile.store-held', 'in-use'], ['profile.store-unheld', 'free'],
  ['profile.store-missing', 'unknown'], ['profile.store-invalid', 'unknown'],
  ['profile.probe-unavailable', 'unknown'], ['profile.managed-running-unobserved', 'unknown'],
  ['profile.service-unverifiable', 'unknown'],
]);
function absolute(value: string) {
  if (typeof value !== 'string' || !paths.isAbsolute(value) || paths.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) fail('invalid-path');
}
function validate(c: ServiceContext) {
  for (const key of ['dataDir', 'configPath', 'storePath', 'repoRoot', 'nodePath', 'logDir'] as const) absolute(c[key]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(c.serviceName)) fail('invalid-name');
  if (c.configPath !== paths.join(c.dataDir, 'agent-config.json') || c.storePath !== paths.join(c.dataDir, 'murmur.db') || c.logDir !== paths.join(c.dataDir, 'logs')) fail('conflicting-store-path');
}
const empty = (detail?: string): ServiceSnapshot => ({ state: 'unknown', manager: 'windows-service', since: null, pid: null,
  lastExitCode: null, observedStorePath: null, restartCount: null, restartWindowMs: null, ...(detail ? { detail } : {}) });
const defaultRun: NonNullable<WindowsOptions['run']> = (file, args, options) => new Promise(resolve => {
  execFile(file, args, { ...options, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr });
  });
});

/** Native SCM helper is the only service observer and mutator. No shell, PID guessing or registry fallback. */
export function createWindowsAdapter(options: WindowsOptions = {}): PlatformAdapter {
  const env = options.env ?? process.env, home = options.homeDir ?? homedir();
  const run = options.run ?? defaultRun, canonicalize = options.canonicalize ?? realpath;
  const same = async (a: string, b: string) => (await canonicalize(a)) === (await canonicalize(b));
  async function helper(c: ServiceContext) {
    const explicit = options.helperPath ?? env.MURMUR_SERVICE_BIN;
    if (explicit !== undefined) { absolute(explicit); return explicit; }
    for (const file of [paths.join(c.repoRoot, 'bin', 'murmur-svc.exe'), paths.join(c.repoRoot, 'spikes', 'windows-service-go', 'murmur-svc.exe')]) {
      try { if ((await stat(file)).isFile()) return file; } catch {}
    }
    return fail('helper-not-installed');
  }
  function selectedEnvironment(c: ServiceContext): NodeJS.ProcessEnv {
    const selected: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'ProgramData', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH']) {
      const found = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
      if (found && env[found] !== undefined) selected[name] = env[found];
    }
    return { ...selected, DATA_DIR: c.dataDir, MURMUR_DATA_DIR: c.dataDir, MURMUR_NODE: c.nodePath,
      MURMUR_ENTRY: paths.join(c.repoRoot, 'scripts', 'murmur-daemon.mjs'), MURMUR_WORKDIR: c.repoRoot,
      MURMUR_SERVICE_NAME: c.serviceName, MURMUR_RESTARTS_PER_HOUR_LIMIT: '5' };
  }
  async function invoke(c: ServiceContext, action: string) {
    validate(c);
    const result = await run(await helper(c), [action], { env: selectedEnvironment(c), timeout: action === 'status' || action === 'profile-usage' ? 8000 : 55000 });
    if (result.code !== 0) fail('helper-command-failed');
    return result.stdout;
  }
  async function inspect(c: ServiceContext): Promise<{ snapshot: ServiceSnapshot; installed: boolean }> {
    let v: Record<string, any>;
    try { const parsed = JSON.parse(await invoke(c, 'status')); if (!object(parsed)) fail('native-response-invalid'); v = parsed; }
    catch (error) { if (error instanceof SyntaxError) fail('native-response-invalid'); throw error; }
    const keys = ['schema', 'serviceName', 'profile', 'state', 'manager', 'pid', 'daemonPid', 'since', 'lastExitCode', 'lastFailureAt',
      'observedStorePath', 'observedStoreUnknownReason', 'restartCount', 'restartWindowMs', 'restartsLastHour', 'restartsUnknownReason', 'restartsPerHourLimit'];
    if (keys.some(k => !Object.hasOwn(v, k)) || v.schema !== 'murmur.windows-service/1' || v.serviceName !== c.serviceName
      || !['running', 'stopped', 'failed', 'unknown'].includes(v.state) || !['windows-service', 'none', 'foreign'].includes(v.manager)
      || !natural(v.pid) || !(v.daemonPid === null || natural(v.daemonPid) && v.daemonPid > 0)
      || !(v.lastExitCode === null || Number.isSafeInteger(v.lastExitCode))
      || !['since', 'lastFailureAt', 'observedStorePath', 'observedStoreUnknownReason', 'restartsUnknownReason'].every(k => textOrNull(v[k]))
      || !['since', 'lastFailureAt'].every(k => v[k] === null || Number.isFinite(Date.parse(v[k])))
      || v.restartsPerHourLimit !== 5) fail('native-response-invalid');
    if (!(v.restartCount === null && v.restartWindowMs === null || natural(v.restartCount) && natural(v.restartWindowMs) && v.restartWindowMs <= 3600000)
      || (v.restartWindowMs === 3600000 ? v.restartsLastHour !== v.restartCount : v.restartsLastHour !== null)) fail('native-response-invalid');
    if (v.manager === 'none') {
      if (v.state !== 'stopped' || v.profile !== null || v.pid !== 0 || v.daemonPid !== null || v.observedStorePath !== null || v.restartCount !== null) fail('native-response-invalid');
      return { snapshot: { ...empty('service.not-installed'), state: 'stopped' }, installed: false };
    }
    if (v.manager === 'foreign' || !object(v.profile)) fail('profile-unverified');
    const expected = { dataDir: c.dataDir, node: c.nodePath, workDir: c.repoRoot, entry: paths.join(c.repoRoot, 'scripts', 'murmur-daemon.mjs') };
    for (const [key, value] of Object.entries(expected)) {
      absolute(v.profile[key]);
      if (!await same(v.profile[key], value)) fail('profile-mismatch');
    }
    if (v.profile.restartsPerHourLimit !== 5 || v.state === 'running' && v.pid === 0) fail('native-response-invalid');
    let observed: string | null = null;
    if (v.observedStorePath !== null) {
      absolute(v.observedStorePath);
      if (v.daemonPid === null || !await same(v.observedStorePath, c.storePath)) fail('observed-store-mismatch');
      observed = await canonicalize(v.observedStorePath);
    }
    return { installed: true, snapshot: { ...empty(), state: v.state, since: v.since, pid: v.daemonPid,
      lastExitCode: v.lastExitCode, observedStorePath: observed, restartCount: v.restartCount, restartWindowMs: v.restartWindowMs } };
  }
  async function mutate(c: ServiceContext, action: 'install' | 'start' | 'stop' | 'uninstall') {
    validate(c);
    const before = await inspect(c);
    if (action === 'install' && before.installed) fail('already-installed');
    if (action !== 'install' && !before.installed) {
      if (action === 'stop' || action === 'uninstall') return;
      fail('not-installed');
    }
    await invoke(c, action);
    const after = await inspect(c);
    if (action === 'uninstall' ? after.installed : !after.installed
      || (action === 'stop' ? after.snapshot.state !== 'stopped' : after.snapshot.state !== 'running' || after.snapshot.pid === null)) fail('action-unconfirmed');
  }
  return {
    manager: 'windows-service',
    async status(c) {
      try { return (await inspect(c)).snapshot; }
      catch (e) { const reason = e instanceof Error && /^service\.[a-z-]+$/.test(e.message) ? e.message : 'service.measurement-failed'; return empty(reason); }
    },
    install: c => mutate(c, 'install'), start: c => mutate(c, 'start'), stop: c => mutate(c, 'stop'), uninstall: c => mutate(c, 'uninstall'),
    async profileUsage(c) {
      try {
        const value: unknown = JSON.parse(await invoke(c, 'profile-usage'));
        if (!object(value) || Object.keys(value).sort().join(',') !== 'reason,schema,state'
          || value.schema !== 'murmur.windows-profile-usage/1'
          || !['free', 'in-use', 'unknown'].includes(value.state)
          || typeof value.reason !== 'string' || profileUsageReasons.get(value.reason) !== value.state) return usageUnknown();
        return { state: value.state as ProfileUsageSnapshot['state'], reason: value.reason };
      } catch { return usageUnknown(); }
    },
    async detectClients(): Promise<ClientDetection[]> {
      const rows: ClientDetection[] = [];
      for (const [id, command, configPath, format] of [
        ['claude-code', 'claude', env.CLAUDE_CONFIG_DIR ? null : paths.join(home, '.claude.json'), 'json'],
        ['codex-cli', 'codex', paths.join(env.CODEX_HOME || paths.join(home, '.codex'), 'config.toml'), 'toml'],
      ] as const) {
        let installed = false;
        for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
          if (!paths.isAbsolute(dir)) continue;
          for (const suffix of ['.exe', '.cmd', '.bat']) {
            try { if ((await stat(paths.join(dir, command + suffix))).isFile()) installed = true; } catch {}
          }
        }
        rows.push({ id, installed, configPath: configPath && paths.isAbsolute(configPath) ? configPath : null, format });
      }
      return rows;
    },
  };
}
