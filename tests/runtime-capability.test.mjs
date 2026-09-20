import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('CLI reports unavailable SQLite before loading the engine or creating a profile', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-runtime-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'not-created');
  const result = spawnSync(process.execPath, ['--no-experimental-sqlite', 'packages/setup/bin/murmur.mjs', 'init', '--data-dir', dataDir], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /runtime\.sqlite-unavailable:.*Node\.js 22\.13\.0/);
  assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|node:internal/);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
});

const { checkRuntime, MIN_NODE_VERSION } = await import('../scripts/runtime-capability.mjs');

test('version floor rejects unsupported Node before attempting SQLite', async () => {
  for (const version of ['20.19.0', '22.0.0', '22.5.0', '22.12.9', 'invalid']) {
    let loaded = false;
    await assert.rejects(checkRuntime({ version, loadSqlite: async () => { loaded = true; } }), { code: 'runtime.node-version-unsupported' });
    assert.equal(loaded, false, version);
  }
});

test('supported versions still require SQLite and redact loader failures', async () => {
  for (const version of [MIN_NODE_VERSION, '22.22.3', '24.0.0']) {
    await assert.rejects(checkRuntime({ version, loadSqlite: async () => { throw new Error('private-loader-payload'); } }), error => {
      assert.equal(error.code, 'runtime.sqlite-unavailable');
      assert.doesNotMatch(error.message, /private-loader-payload/);
      return true;
    });
  }
  await checkRuntime({ version: MIN_NODE_VERSION });
});

test('pre-install checker fails clearly when SQLite is disabled', () => {
  const result = spawnSync(process.execPath, ['--no-experimental-sqlite', 'scripts/check-runtime.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /runtime\.sqlite-unavailable/);
  assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|node:internal/);
});

test('install metadata and documented Node floors agree with the runtime policy', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url)));
  assert.equal(pkg.engines.node, `>=${MIN_NODE_VERSION}`);
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  const wake = await fs.readFile(new URL('../docs/wake-native.md', import.meta.url), 'utf8');
  const stated = [...readme.matchAll(/Node(?:\.js)? (\d+(?:\.\d+){0,2})\+/g)].map(match => match[1]);
  assert.ok(stated.length >= 4, 'install, quick start and storage requirements remain present');
  for (const version of stated) assert.equal(version, MIN_NODE_VERSION);
  assert.ok(readme.includes(`badge/node-%3E%3D${MIN_NODE_VERSION}-`));
  const wakeVersion = /Requires Node with `node:sqlite`\s*\((\d+(?:\.\d+){0,2})\+\)/.exec(wake);
  assert.equal(wakeVersion?.[1], MIN_NODE_VERSION);
});

test('documentation gate names mismatched requirements before build', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-node-docs-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const file of ['package.json', 'README.md', 'CONTRIBUTING.md', 'docs/wake-native.md', 'scripts/runtime-capability.mjs', 'scripts/check-node-requirements.mjs']) {
    await fs.mkdir(path.dirname(path.join(temp, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(temp, file));
  }
  const run = () => spawnSync(process.execPath, ['scripts/check-node-requirements.mjs'], { cwd: temp, encoding: 'utf8' });
  assert.equal(run().status, 0);
  await fs.writeFile(path.join(temp, 'CONTRIBUTING.md'), 'Requires Node.js 22+\n');
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONTRIBUTING\.md: Node\.js 22 disagrees/);
  await fs.copyFile(path.join(root, 'CONTRIBUTING.md'), path.join(temp, 'CONTRIBUTING.md'));
  await fs.appendFile(path.join(temp, 'README.md'), '\nRequires Node.js 22+\n');
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: Node\.js 22 disagrees/);
  await fs.copyFile(path.join(root, 'README.md'), path.join(temp, 'README.md'));
  await fs.mkdir(path.join(temp, 'site'));
  await fs.writeFile(path.join(temp, 'site/index.html'), 'Проверь node 22.5 или новее');
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /site\/index\.html: Node\.js 22\.5 disagrees/);
});
