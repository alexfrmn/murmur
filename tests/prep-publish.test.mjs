import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t, packages, prefix = 'murmur-release-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(new URL('../scripts/prep-publish.mjs', import.meta.url), path.join(root, 'scripts/prep-publish.mjs'));
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
  consumer: { name: '@murmurv2/consumer', version: '1.2.0', dependencies: { '@murmurv2/core': 'file:../core' }, optionalDependencies: { '@murmurv2/core': '^0.5.0' } },
  setup: { name: '@murmurv2/setup', version: '0.1.0', private: true, bin: { murmur: 'bin/murmur.mjs' }, files: ['bin', 'dist'] },
});

test('prep uses dependency versions, preserves private packages, and is idempotent', async t => {
  const f = await fixture(t, packages());
  const privateBefore = await f.read('setup');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const consumer = JSON.parse(await f.read('consumer'));
  assert.equal(consumer.dependencies['@murmurv2/core'], '^0.6.3');
  assert.equal(consumer.optionalDependencies['@murmurv2/core'], '^0.6.3');
  assert.equal(await f.read('setup'), privateBefore);
  assert.equal(JSON.parse(await f.read('core')).description, 'Current maintained description');
  const before = await f.read('consumer');
  assert.equal(f.run().status, 0);
  assert.equal(await f.read('consumer'), before);
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
