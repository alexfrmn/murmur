import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import semver from 'semver';

async function fixture(t, packages, prefix = 'murmur-release-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(new URL('../scripts/prep-publish.mjs', import.meta.url), path.join(root, 'scripts/prep-publish.mjs'));
  await fs.cp(path.dirname(createRequire(import.meta.url).resolve('semver/package.json')), path.join(root, 'node_modules/semver'), { recursive: true });
  for (const [dir, pkg] of Object.entries(packages)) {
    await fs.mkdir(path.join(root, 'packages', dir), { recursive: true });
    await fs.writeFile(path.join(root, 'packages', dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/prep-publish.mjs'), ...args], { encoding: 'utf8', cwd: os.tmpdir() });
  const read = dir => fs.readFile(path.join(root, 'packages', dir, 'package.json'), 'utf8');
  return { root, run, read };
}
const packages = () => ({
  core: { name: '@murmurv2/core', version: '0.6.3', description: 'Current maintained description' },
  consumer: { name: '@murmurv2/consumer', version: '1.2.0', dependencies: { '@murmurv2/core': 'file:../core' }, optionalDependencies: { '@murmurv2/core': '>=0.5.0 <1' } },
  setup: { name: '@murmurv2/setup', version: '0.1.0', private: true, bin: { murmur: 'bin/murmur.mjs' }, files: ['bin', 'dist'] },
});

test('prep uses dependency versions, preserves private packages, and is idempotent', async t => {
  const f = await fixture(t, packages());
  const privateBefore = await f.read('setup');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const consumer = JSON.parse(await f.read('consumer'));
  assert.equal(consumer.dependencies['@murmurv2/core'], '^0.6.3');
  assert.equal(consumer.optionalDependencies['@murmurv2/core'], '>=0.5.0 <1');
  assert.equal(await f.read('setup'), privateBefore);
  assert.equal(JSON.parse(await f.read('core')).description, 'Current maintained description');
  const before = await f.read('consumer');
  assert.equal(f.run().status, 0);
  assert.equal(await f.read('consumer'), before);
});

test('prep preserves pins, tilde, peer unions and comparators instead of widening the contract', async t => {
  for (const range of ['0.6.3', '~0.6.3', '>=0.6.2 <0.7', '^0.5.0 || ^0.6.0']) {
    const p = packages(); p.consumer.dependencies = { '@murmurv2/core': range };
    p.consumer.peerDependencies = { '@murmurv2/core': range };
    const f = await fixture(t, p);
    assert.equal(f.run().status, 0);
    const actual = JSON.parse(await f.read('consumer'));
    assert.equal(actual.dependencies['@murmurv2/core'], range);
    assert.equal(actual.peerDependencies['@murmurv2/core'], range);
  }
});

test('incompatible ranges fail before writes; local workspace protocols become registry ranges', async t => {
  for (const range of ['^0.5.0', '0.6.2', 'workspace:^0.5.0', 'file:../wrong']) {
    const p = packages(); p.consumer.dependencies = { '@murmurv2/core': range };
    const f = await fixture(t, p), before = await f.read('core');
    assert.notEqual(f.run().status, 0, range);
    assert.equal(await f.read('core'), before);
  }
  for (const [input, expected] of [['workspace:*', '0.6.3'], ['workspace:^', '^0.6.3'], ['workspace:~', '~0.6.3'], ['workspace:>=0.6.0 <1', '>=0.6.0 <1']]) {
    const p = packages(); p.consumer.dependencies = { '@murmurv2/core': input };
    const f = await fixture(t, p);
    assert.equal(f.run().status, 0, input);
    assert.equal(JSON.parse(await f.read('consumer')).dependencies['@murmurv2/core'], expected);
  }
});

test('CLI preparation retains its runtime staging guard and executable payload', async t => {
  const f = await fixture(t, { cli: { name: '@murmurv2/cli', version: '2.10.0' } });
  assert.equal(f.run().status, 0);
  const cli = JSON.parse(await f.read('cli'));
  assert.equal(cli.scripts.prepack, 'npm run build --prefix ../.. && node ../../scripts/prepare-cli-package.mjs');
  assert.ok(cli.files.includes('runtime'));
  assert.ok(cli.files.includes('bin/murmur-npm.mjs'));
});

test('check detects drift without writing and succeeds after preparation', async t => {
  const f = await fixture(t, packages());
  const before = await f.read('consumer');
  assert.equal(f.run('--check').status, 1);
  assert.equal(await f.read('consumer'), before);
  assert.equal(f.run().status, 0);
  assert.equal(f.run('--check').status, 0);
});

test('missing or private workspace dependency aborts before any manifest mutation', async t => {
  for (const dep of ['@murmurv2/missing', '@murmurv2/setup']) {
    const p = packages(); p.consumer.dependencies = { [dep]: '*' };
    const f = await fixture(t, p), before = await f.read('core');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(await f.read('core'), before);
  }
});

test('prep resolves URL-encoded checkout paths independently of cwd', async t => {
  const f = await fixture(t, packages(), 'murmur release #');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('current workspace preparation resolves every public internal dependency and preserves private manifests', async t => {
  const workspace = {};
  for (const dir of await fs.readdir(new URL('../packages/', import.meta.url))) {
    try { workspace[dir] = JSON.parse(await fs.readFile(new URL(`../packages/${dir}/package.json`, import.meta.url), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const f = await fixture(t, workspace);
  const originals = new Map(await Promise.all(Object.keys(workspace).map(async dir => [dir, await f.read(dir)])));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const byName = new Map(Object.values(workspace).map(pkg => [pkg.name, pkg]));
  let checked = 0;
  for (const [dir, original] of Object.entries(workspace)) {
    const contents = await f.read(dir);
    if (original.private === true) { assert.equal(contents, originals.get(dir), dir); continue; }
    const prepared = JSON.parse(contents);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(prepared[field] ?? {})) {
        if (!name.startsWith('@murmurv2/')) continue;
        const target = byName.get(name);
        assert.ok(target && target.private !== true, `${prepared.name}: public target ${name}`);
        assert.ok(semver.satisfies(target.version, range), `${prepared.name}: ${field}.${name}`);
        assert.equal(range, original[field][name], 'existing registry range is preserved');
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'real workspace internal dependencies must be exercised');
  assert.equal(f.run('--check').status, 0);
  const coreFile = path.join(f.root, 'packages/core/package.json');
  const core = JSON.parse(await fs.readFile(coreFile, 'utf8'));
  core.version = '99.0.0';
  await fs.writeFile(coreFile, JSON.stringify(core, null, 2) + '\n');
  assert.equal(f.run('--check').status, 1, 'changing a dependency version without synchronizing consumers must fail the CI gate');
});
