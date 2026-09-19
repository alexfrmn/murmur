import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 4000;
export const UPDATE_ENDPOINT = 'https://api.github.com/repos/alexfrmn/murmur/releases/latest';
const RELEASE_BASE = 'https://github.com/alexfrmn/murmur/releases/tag/';
const MAX_BYTES = 128 * 1024;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function versionParts(value: unknown): bigint[] | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const match = versionPattern.exec(value);
  return match ? match.slice(1, 4).map(BigInt) : null;
}
export function compareReleaseVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) throw new Error('updates.version-invalid');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export async function readVersion(manifest = new URL('../../../../package.json', import.meta.url)) {
  const pkg = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (pkg.name !== 'murmur' || !versionParts(pkg.version)) throw new Error('version.root-manifest-invalid');
  return { schema: 'murmur.version/1' as const, product: 'Murmur', version: pkg.version as string,
    source: 'root-package-json' as const, comparison: 'declared-release-version' as const };
}

export interface UpdateResult {
  schema: 'murmur.updates/1'; channel: 'stable'; currentVersion: string | null;
  versionSource: 'root-package-json'; comparison: 'declared-release-version';
  enabled: boolean; state: 'up-to-date' | 'available' | 'unknown'; reason: string;
  latestVersion: string | null; releaseUrl: string | null; action: 'open-release-page' | null;
  checkedAt: string | null; lastSuccessAt: string | null; nextCheckAt: string | null;
  cached: boolean; stale: boolean; checkIntervalMs: number; timeoutMs: number;
}
type Release = { version: string; tag: string };
type Cache = { schema: 'murmur.update-cache/1'; checkedAt: string; lastSuccessAt: string | null;
  reason: string; release: Release | null };
type Options = { directory?: string; now?: () => number; fetch?: typeof fetch; manifest?: URL;
  timeoutMs?: number; env?: NodeJS.ProcessEnv };

export function updateDirectory(env = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const parent = platform === 'win32' ? (env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
    : (env.XDG_STATE_HOME || paths.join(home, '.local', 'state'));
  if (!paths.isAbsolute(parent)) throw new Error('updates.state-path-invalid');
  return paths.join(parent, 'Murmur', 'updates');
}
function date(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString() === value ? n : null;
}
async function readJson(file: string): Promise<any | undefined> {
  let handle;
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error('updates.state-invalid');
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('updates.state-invalid');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('updates.state-invalid');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}
async function prepare(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error('updates.state-path-invalid');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('updates.state-invalid');
}
async function writeJson(directory: string, name: string, value: unknown) {
  const temporary = path.join(directory, `.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path.join(directory, name));
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function preference(directory: string): Promise<boolean> {
  const value = await readJson(path.join(directory, 'preferences.json'));
  if (value === undefined) return true;
  if (!value || value.schema !== 'murmur.update-preferences/1' || typeof value.enabled !== 'boolean') {
    throw new Error('updates.preferences-invalid');
  }
  return value.enabled;
}
async function lock(directory: string): Promise<() => Promise<void>> {
  const file = path.join(directory, 'check.lock');
  try { await fs.mkdir(file); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    // The request is bounded to four seconds. Recover an abandoned empty lock,
    // but never wait for another client or let it stall application startup.
    const stat = await fs.lstat(file);
    if (!stat.isDirectory() || Date.now() - stat.mtimeMs < 60_000) throw new Error('updates.check-in-progress');
    await fs.rmdir(file);
    await fs.mkdir(file);
  }
  return async () => { await fs.rmdir(file); };
}
export async function setUpdateChecks(enabled: boolean, options: Options = {}) {
  const directory = options.directory ?? updateDirectory(options.env);
  await prepare(directory);
  const unlock = await lock(directory);
  try {
    const result = { schema: 'murmur.update-preferences/1', enabled };
    await writeJson(directory, 'preferences.json', result);
    return result;
  } finally { await unlock(); }
}
function validCache(value: any): value is Cache {
  if (!value || value.schema !== 'murmur.update-cache/1' || date(value.checkedAt) === null ||
      (value.lastSuccessAt !== null && date(value.lastSuccessAt) === null)) return false;
  if (value.reason === 'updates.checked') {
    return value.lastSuccessAt === value.checkedAt && value.release && versionParts(value.release.version) !== null &&
      value.release.tag === `v${value.release.version}`;
  }
  return value.release === null && ['updates.network-error', 'updates.timeout', 'updates.rate-limited',
    'updates.http-error', 'updates.release-invalid', 'updates.interrupted'].includes(value.reason);
}
async function requestRelease(fetcher: typeof fetch, timeoutMs: number): Promise<Release> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(UPDATE_ENDPOINT, { signal: controller.signal, redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Murmur-update-check' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 403 || response.status === 429 ? 'updates.rate-limited' : 'updates.http-error');
    }
    if (!response.body) throw new Error('updates.release-invalid');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('updates.release-invalid'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('updates.release-invalid'); }
    const version = typeof data.tag_name === 'string' ? data.tag_name.slice(1) : null;
    if (data.draft !== false || data.prerelease !== false || !versionParts(version) ||
        data.tag_name !== `v${version}` || data.html_url !== RELEASE_BASE + encodeURIComponent(data.tag_name) ||
        typeof data.published_at !== 'string' || !Number.isFinite(Date.parse(data.published_at))) {
      throw new Error('updates.release-invalid');
    }
    return { version: version!, tag: data.tag_name };
  } catch (error: any) {
    if (controller.signal.aborted) throw new Error('updates.timeout');
    if (['updates.rate-limited', 'updates.http-error', 'updates.release-invalid'].includes(error.message)) throw error;
    throw new Error('updates.network-error');
  } finally { clearTimeout(timer); }
}

export async function checkUpdates(options: Options = {}): Promise<UpdateResult> {
  const now = options.now ?? Date.now;
  const result: UpdateResult = { schema: 'murmur.updates/1', channel: 'stable', currentVersion: null,
    versionSource: 'root-package-json', comparison: 'declared-release-version', enabled: true,
    state: 'unknown', reason: 'updates.not-checked', latestVersion: null, releaseUrl: null, action: null,
    checkedAt: null, lastSuccessAt: null, nextCheckAt: null, cached: false, stale: false,
    checkIntervalMs: UPDATE_INTERVAL_MS, timeoutMs: UPDATE_TIMEOUT_MS };
  try { result.currentVersion = (await readVersion(options.manifest)).version; }
  catch { return { ...result, reason: 'updates.current-version-invalid' }; }
  if ((options.env ?? process.env).MURMUR_UPDATE_CHECK === '0') return { ...result, enabled: false, reason: 'updates.disabled' };
  let directory: string;
  try {
    directory = options.directory ?? updateDirectory(options.env);
    result.enabled = await preference(directory);
  } catch { return { ...result, enabled: false, reason: 'updates.preferences-unavailable' }; }
  if (!result.enabled) return { ...result, reason: 'updates.disabled' };
  let unlock: (() => Promise<void>) | undefined;
  try {
    await prepare(directory);
    unlock = await lock(directory);
    // Re-read under the cross-process lock: disabling and competing checks cannot
    // race the decision to initiate the next network request.
    if (!await preference(directory)) return { ...result, enabled: false, reason: 'updates.disabled' };
    const saved = await readJson(path.join(directory, 'cache.json'));
    if (saved !== undefined && !validCache(saved)) return { ...result, reason: 'updates.cache-invalid' };
    let cache: Cache | null = saved ?? null;
    const at = now();
    if (cache && (date(cache.checkedAt)! > at || (cache.lastSuccessAt !== null && date(cache.lastSuccessAt)! > date(cache.checkedAt)!))) {
      return { ...result, reason: 'updates.cache-invalid' };
    }
    if (cache && at - date(cache.checkedAt)! < UPDATE_INTERVAL_MS) result.cached = true;
    else {
      result.stale = cache !== null;
      cache = { schema: 'murmur.update-cache/1', checkedAt: new Date(at).toISOString(),
        lastSuccessAt: cache?.lastSuccessAt ?? null, release: null, reason: 'updates.interrupted' };
      // Persist the attempt before fetching. Network failure or a killed client
      // must not cause every status refresh to hit GitHub again.
      await writeJson(directory, 'cache.json', cache);
      try {
        cache.release = await requestRelease(options.fetch ?? fetch, options.timeoutMs ?? UPDATE_TIMEOUT_MS);
        cache.reason = 'updates.checked'; cache.lastSuccessAt = cache.checkedAt;
      } catch (error: any) { cache.reason = error.message; }
      await writeJson(directory, 'cache.json', cache);
    }
    result.checkedAt = cache.checkedAt;
    result.lastSuccessAt = cache.lastSuccessAt;
    result.nextCheckAt = new Date(date(cache.checkedAt)! + UPDATE_INTERVAL_MS).toISOString();
    if (!cache.release) return { ...result, reason: cache.reason, stale: cache.lastSuccessAt !== null };
    const newer = compareReleaseVersions(cache.release.version, result.currentVersion) > 0;
    return { ...result, stale: false, state: newer ? 'available' : 'up-to-date',
      reason: newer ? 'updates.newer-release' : 'updates.no-newer-release', latestVersion: cache.release.version,
      releaseUrl: newer ? RELEASE_BASE + encodeURIComponent(cache.release.tag) : null,
      action: newer ? 'open-release-page' : null };
  } catch (error: any) {
    return { ...result, state: 'unknown', reason: error.message === 'updates.check-in-progress'
      ? 'updates.check-in-progress' : 'updates.cache-unavailable' };
  } finally { await unlock?.().catch(() => {}); }
}
