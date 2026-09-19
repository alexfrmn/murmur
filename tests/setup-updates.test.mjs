import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readVersion, checkUpdates, setUpdateChecks, compareReleaseVersions,
  updateDirectory, UPDATE_ENDPOINT, UPDATE_INTERVAL_MS } from '../packages/setup/dist/src/updates.js';
import { main } from '../packages/setup/dist/src/cli.js';

const at = Date.parse('2026-09-19T17:00:00.000Z');
const release = (version = '2.10.0', extra = {}) => ({ tag_name: 'v' + version,
  html_url: 'https://github.com/alexfrmn/murmur/releases/tag/' + encodeURIComponent('v' + version),
  published_at: '2026-09-19T12:00:00Z', prerelease: false, draft: false, ...extra });
const response = data => new Response(JSON.stringify(data), { status: 200 });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-updates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifest = pathToFileURL(path.join(dir, 'package.json'));
  await fs.writeFile(manifest, JSON.stringify({ name: 'murmur', version: '2.9.0' }));
  return { dir, options: { directory: path.join(dir, 'state'), manifest, env: {}, now: () => at } };
}

test('version is exactly the root product version and needs no profile/service', async () => {
  const root = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const bad = new Proxy({}, { get() { throw new Error('service-must-not-be-used'); } });
  const result = await main(['version', '--json', '--data-dir', 'invalid-relative'], bad);
  assert.deepEqual(result, { schema: 'murmur.version/1', product: 'Murmur', version: root.version,
    source: 'root-package-json', comparison: 'declared-release-version' });
  assert.equal((await readVersion()).version, root.version);
});

test('stable versions compare numerically, ignore build metadata and reject approximations', () => {
  for (const [a, b, expected] of [['2.10.0', '2.9.0', 1], ['3.0.0', '2.99.99', 1],
    ['2.9.0', '2.10.0', -1], ['2.9.0+build.1', '2.9.0+other', 0], ['0.1.9', '0.1.10', -1]]) {
    assert.equal(compareReleaseVersions(a, b), expected);
  }
  for (const bad of ['02.9.0', '2.9', '2.9.0.1', '2.9.0-beta.1', '2.9.0\n', '2.9.0+']) {
    assert.throws(() => compareReleaseVersions(bad, '2.9.0'));
  }
});

test('new release gives only an official page action, without auth or profile data', async t => {
  const { options } = await fixture(t);
  let calls = 0;
  const result = await checkUpdates({ ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(url, UPDATE_ENDPOINT);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'User-Agent', 'X-GitHub-Api-Version']);
    assert.equal(init.headers['User-Agent'], 'Murmur-update-check');
    assert.equal(init.body, undefined);
    return response(release());
  } });
  assert.equal(calls, 1);
  assert.equal(result.state, 'available');
  assert.equal(result.latestVersion, '2.10.0');
  assert.equal(result.action, 'open-release-page');
  assert.equal(result.releaseUrl, release().html_url);
  assert.equal(result.checkedAt, new Date(at).toISOString());
  assert.equal(result.lastSuccessAt, result.checkedAt);
  assert.equal(result.nextCheckAt, new Date(at + UPDATE_INTERVAL_MS).toISOString());
  assert.equal(result.cached, false);
});

test('cache avoids network for six hours and re-compares against changed local version', async t => {
  const { options } = await fixture(t);
  const original = await checkUpdates({ ...options, fetch: async () => response(release()) });
  const noFetch = async () => { throw new Error('unexpected-network'); };
  const cached = await checkUpdates({ ...options, now: () => at + 1000, fetch: noFetch });
  assert.equal(cached.state, 'available'); assert.equal(cached.cached, true);
  assert.equal(cached.checkedAt, original.checkedAt);
  await fs.writeFile(options.manifest, JSON.stringify({ name: 'murmur', version: '2.11.0' }));
  const newerLocal = await checkUpdates({ ...options, fetch: noFetch });
  assert.equal(newerLocal.state, 'up-to-date');
  assert.equal(newerLocal.reason, 'updates.no-newer-release');
  assert.equal(newerLocal.releaseUrl, null); assert.equal(newerLocal.action, null);
});

test('expired successful cache plus network failure is unknown, timestamped and throttled', async t => {
  const { options } = await fixture(t);
  await checkUpdates({ ...options, fetch: async () => response(release('2.9.0')) });
  let calls = 0;
  const fail = async () => { calls++; throw new Error('PRIVATE network details'); };
  const next = { ...options, now: () => at + UPDATE_INTERVAL_MS, fetch: fail };
  const result = await checkUpdates(next);
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'updates.network-error');
  assert.equal(result.lastSuccessAt, new Date(at).toISOString());
  assert.equal(result.checkedAt, new Date(at + UPDATE_INTERVAL_MS).toISOString());
  assert.equal(result.stale, true); assert.equal(result.latestVersion, null);
  assert.equal(result.action, null); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const cached = await checkUpdates(next);
  assert.equal(cached.state, 'unknown'); assert.equal(cached.cached, true); assert.equal(calls, 1);
});

for (const [name, data] of [
  ['prerelease flag', release('2.10.0', { prerelease: true })], ['draft', release('2.10.0', { draft: true })],
  ['prerelease version', release('2.10.0-rc.1')], ['malformed version', release('02.10.0')],
  ['foreign URL', release('2.10.0', { html_url: 'https://attacker.invalid/install' })],
  ['wrong release URL', release('2.10.0', { html_url: release('2.8.0').html_url })],
  ['missing flags', { tag_name: 'v2.10.0' }], ['oversized body', { text: 'a'.repeat(129 * 1024) }],
]) test(`updates reject ${name} without presenting an install action`, async t => {
  const { options } = await fixture(t);
  const result = await checkUpdates({ ...options, fetch: async () => response(data) });
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'updates.release-invalid');
  assert.equal(result.releaseUrl, null); assert.equal(result.action, null);
});

for (const status of [403, 429, 404, 500]) test(`HTTP ${status} is an unknown cached attempt`, async t => {
  const { options } = await fixture(t);
  let calls = 0;
  const settings = { ...options, fetch: async () => { calls++; return new Response('private', { status }); } };
  const result = await checkUpdates(settings);
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, status === 403 || status === 429 ? 'updates.rate-limited' : 'updates.http-error');
  await checkUpdates(settings); assert.equal(calls, 1);
});

for (const mode of ['request', 'body']) test(`${mode} is aborted by the deadline`, async t => {
  const { options } = await fixture(t);
  const started = Date.now();
  const result = await checkUpdates({ ...options, timeoutMs: 30, fetch: async (_url, init) => {
    if (mode === 'request') return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
    } }));
  } });
  assert.equal(result.reason, 'updates.timeout');
  assert.equal(result.state, 'unknown'); assert.ok(Date.now() - started < 1500);
});

test('invalid root version is unknown without fallback or networking', async t => {
  const { options } = await fixture(t);
  for (const pkg of [{ name: '@murmurv2/setup', version: '0.1.0' }, { name: 'murmur', version: '2.10.0-beta' }]) {
    await fs.writeFile(options.manifest, JSON.stringify(pkg));
    await assert.rejects(readVersion(options.manifest), /version.root-manifest-invalid/);
    let calls = 0;
    const result = await checkUpdates({ ...options, fetch: () => { calls++; throw new Error('must not call'); } });
    assert.equal(result.state, 'unknown'); assert.equal(result.currentVersion, null);
    assert.equal(result.reason, 'updates.current-version-invalid'); assert.equal(calls, 0);
  }
});

test('cache storage failure prevents a request that could not be throttled', async t => {
  const { options } = await fixture(t);
  await fs.mkdir(options.directory);
  await fs.mkdir(path.join(options.directory, 'cache.json'));
  let calls = 0;
  const result = await checkUpdates({ ...options, fetch: () => { calls++; throw new Error('must not call'); } });
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'updates.cache-unavailable');
  assert.equal(calls, 0);
});

test('concurrent clients issue one request; in-progress observations are not successes', async t => {
  const { options } = await fixture(t);
  let calls = 0, releaseFetch;
  const gate = new Promise(resolve => { releaseFetch = resolve; });
  const fetch = async () => { calls++; await gate; return response(release()); };
  const first = checkUpdates({ ...options, fetch });
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  const others = await Promise.all(Array.from({ length: 8 }, () => checkUpdates({ ...options, fetch })));
  assert.ok(others.every(x => x.state === 'unknown' && x.reason === 'updates.check-in-progress'));
  releaseFetch(); assert.equal((await first).state, 'available'); assert.equal(calls, 1);
});

test('persistent and environment opt-outs issue no request, including enable under override', async t => {
  const { options } = await fixture(t);
  let calls = 0; const fetch = async () => { calls++; return response(release()); };
  assert.deepEqual(await setUpdateChecks(false, options), { schema: 'murmur.update-preferences/1', enabled: false });
  assert.equal((await checkUpdates({ ...options, fetch })).reason, 'updates.disabled');
  await setUpdateChecks(true, options);
  assert.equal((await checkUpdates({ ...options, env: { MURMUR_UPDATE_CHECK: '0' }, fetch })).enabled, false);
  assert.equal(calls, 0);
  assert.equal((await checkUpdates({ ...options, fetch })).state, 'available'); assert.equal(calls, 1);
});

test('invalid preferences and corrupt/future cache fail closed without network', async t => {
  const { options } = await fixture(t);
  await fs.mkdir(options.directory);
  let calls = 0; const fetch = async () => { calls++; return response(release()); };
  const preferences = path.join(options.directory, 'preferences.json');
  for (const body of ['{}', 'null']) {
    await fs.writeFile(preferences, body);
    assert.equal((await checkUpdates({ ...options, fetch })).reason, 'updates.preferences-unavailable');
  }
  await fs.unlink(preferences);
  for (const body of ['broken', 'null', JSON.stringify({ schema: 'murmur.update-cache/1', checkedAt: new Date(at + 1).toISOString(),
    lastSuccessAt: null, release: null, reason: 'updates.interrupted' })]) {
    await fs.writeFile(path.join(options.directory, 'cache.json'), body);
    assert.equal((await checkUpdates({ ...options, fetch })).state, 'unknown');
  }
  assert.equal(calls, 0);
});

test('a persisted interrupted attempt survives process failure and does not immediately retry', async t => {
  const { options } = await fixture(t);
  await fs.mkdir(options.directory);
  await fs.writeFile(path.join(options.directory, 'cache.json'), JSON.stringify({
    schema: 'murmur.update-cache/1', checkedAt: new Date(at).toISOString(), lastSuccessAt: null,
    release: null, reason: 'updates.interrupted' }));
  const result = await checkUpdates({ ...options, fetch: () => { throw new Error('must not fetch'); } });
  assert.equal(result.reason, 'updates.interrupted'); assert.equal(result.cached, true);
});

test('CLI checks can be disabled before any profile exists, from an unrelated cwd', async t => {
  const { dir } = await fixture(t);
  const cli = fileURLToPath(new URL('../packages/setup/bin/murmur.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, MURMUR_UPDATE_CHECK: '0', DATA_DIR: 'relative-invalid', MURMUR_DATA_DIR: 'relative-invalid' } });
  const version = run(['version']); assert.equal(version.status, 0, version.stderr);
  const updates = run(['updates', 'check']); assert.equal(updates.status, 0, updates.stderr);
  assert.equal(JSON.parse(updates.stdout).reason, 'updates.disabled');
  assert.deepEqual(await fs.readdir(dir), ['package.json']);
});

test('per-user state paths are platform specific, absolute and independent of profile environment', () => {
  assert.equal(updateDirectory({ DATA_DIR: '/other' }, 'darwin', '/Users/me'), '/Users/me/Library/Application Support/Murmur/updates');
  assert.equal(updateDirectory({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\Users\\me'), 'C:\\Users\\me\\AppData\\Local\\Murmur\\updates');
  assert.equal(updateDirectory({ XDG_STATE_HOME: '/state' }, 'linux', '/home/me'), '/state/Murmur/updates');
  assert.throws(() => updateDirectory({ XDG_STATE_HOME: 'relative' }, 'linux', '/home/me'));
});
