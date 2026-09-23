import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseOptions, publicationOrder, validatePack, packThenPublish } from '../scripts/publish-all.mjs';

const core = { name: '@murmurv2/core', version: '0.6.3' };
const consumer = { name: '@murmurv2/consumer', version: '1.0.0', dependencies: { [core.name]: '^0.6.3' } };
const files = ['package.json', 'LICENSE', 'dist/src/index.js', 'dist/src/index.d.ts'].map(path => ({ path }));

test('registry is explicit; dry-run is default; ambiguous arguments are rejected', () => {
  assert.throws(() => parseOptions([]), /registry/);
  const options = parseOptions(['--registry=http://127.0.0.1:4873']);
  assert.equal(options.publish, false);
  assert.equal(options.registry, 'http://127.0.0.1:4873/');
  assert.throws(() => parseOptions(['--registry=https://token@example.com']), /registry/);
  assert.throws(() => parseOptions(['--registry', 'http://localhost:4873', '--publish', '--dry-run']), /conflict/);
  assert.throws(() => parseOptions(['--registry', 'http://localhost:4873', '--wat']), /Unknown/);
});

test('publication graph includes CLI after dependencies and rejects cycles/private/missing dependencies', () => {
  const cli = { name: '@murmurv2/cli', version: '2.10.0', dependencies: { [consumer.name]: '^1.0.0' } };
  assert.deepEqual(publicationOrder([cli, consumer, core]).map(p => p.name), [core.name, consumer.name, cli.name]);
  assert.throws(() => publicationOrder([consumer]), /Invalid public/);
  assert.throws(() => publicationOrder([{ ...core, private: true }, consumer]), /Invalid public/);
  assert.throws(() => publicationOrder([{ ...core, dependencies: { [consumer.name]: '^1.0.0' } }, consumer]), /cycle/);
  assert.throws(() => publicationOrder([{ ...core, dependencies: { external: 'git+https://example.com/repo.git' } }]), /Non-registry/);
});

test('pack guard refuses missing CLI runtime/helper, build caches and private profile files', () => {
  const info = { ...core, filename: 'core.tgz', files };
  validatePack(core, info);
  for (const name of ['.data/agent-config.json', 'runtime/private/murmur.db', 'dist/tsconfig.tsbuildinfo', 'runtime/host.invite.txt', 'node_modules/secret']) {
    assert.throws(() => validatePack(core, { ...info, files: [...files, { path: name }] }), /forbidden/);
  }
  const cli = { name: '@murmurv2/cli', version: '2.10.0' };
  assert.throws(() => validatePack(cli, { ...info, ...cli }), /missing/);
});

async function fixture(t, { badLast = false, existing = false, mismatch = false } = {}) {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur npm test '));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const calls = [], published = new Set(), integrities = new Map();
  const run = args => {
    calls.push(args);
    if (args[0] === 'pack') {
      const pkg = args[2] === core.name ? core : consumer;
      const bytes = Buffer.from(pkg.name), filename = pkg.name.split('/')[1] + '.tgz';
      writeFileSync(path.join(out, filename), bytes);
      const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
      integrities.set(`${pkg.name}@${pkg.version}`, integrity);
      return JSON.stringify([{ ...pkg, filename, integrity, size: bytes.length,
        files: badLast && pkg === consumer ? files.slice(0, 2) : files }]);
    }
    if (args[0] === 'view') {
      if (existing || published.has(args[1])) return JSON.stringify(mismatch ? 'different' : integrities.get(args[1]));
      throw Object.assign(new Error('missing'), { stdout: JSON.stringify({ error: { code: 'E404' } }) });
    }
    if (args[0] === 'publish') {
      const pkg = args[1].endsWith('core.tgz') ? core : consumer;
      published.add(`${pkg.name}@${pkg.version}`);
      return '';
    }
    throw new Error('Unexpected npm call');
  };
  return { out, calls, run, root: out, registry: 'http://127.0.0.1:4873/' };
}

test('a broken later tarball cannot leave earlier packages published', async t => {
  const f = await fixture(t, { badLast: true });
  await assert.rejects(packThenPublish([consumer, core], { ...f, publish: true }, f.run), /missing/);
  assert.deepEqual(f.calls.map(c => c[0]), ['pack', 'pack']);
});

test('publish uses exactly the checked tarball bytes and explicit registry, then verifies integrity', async t => {
  const f = await fixture(t);
  const result = await packThenPublish([consumer, core], { ...f, publish: true }, f.run);
  assert.ok(result.every(p => p.published));
  assert.deepEqual(f.calls.map(c => c[0]), ['pack', 'pack', 'view', 'view', 'publish', 'view', 'publish', 'view']);
  for (const args of f.calls.filter(c => c[0] === 'publish')) {
    assert.ok(args.includes('--ignore-scripts'));
    assert.equal(args[args.indexOf('--registry') + 1], f.registry);
    assert.ok(args[1].startsWith(f.out));
  }
});

test('dry-run never contacts registry; resume skips only identical existing bytes', async t => {
  const f = await fixture(t);
  await packThenPublish([core], { ...f, publish: false }, f.run);
  assert.deepEqual(f.calls.map(c => c[0]), ['pack']);
  const same = await fixture(t, { existing: true });
  const result = await packThenPublish([core], { ...same, publish: true, skipExisting: true }, same.run);
  assert.ok(result[0].skipped);
  assert.ok(!same.calls.some(c => c[0] === 'publish'));
  const changed = await fixture(t, { existing: true, mismatch: true });
  await assert.rejects(packThenPublish([core], { ...changed, publish: true, skipExisting: true }, changed.run), /new version/);
  assert.ok(!changed.calls.some(c => c[0] === 'publish'));
});
