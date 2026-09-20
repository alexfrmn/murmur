import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseBuildOptions,
  writeReleaseManifest,
  publishPrepared,
} from '../scripts/build-windows-bundle.mjs';
import { writeZip } from '../scripts/build-runtime-bundle.mjs';

const temporary = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur windows bundle '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('release arguments require one exact output path and keep the selected ref opaque', () => {
  const output = path.resolve(os.tmpdir(), 'new murmur output');
  assert.deepEqual(parseBuildOptions(['--ref', 'release/candidate', '--out', output]), {
    ref: 'release/candidate', output,
  });
  assert.deepEqual(parseBuildOptions(['--out', output]), { ref: 'HEAD', output });
  for (const args of [[], ['--out', 'relative'], ['--wat', 'x', '--out', output],
    ['--ref', 'HEAD'], ['--out', output, '--out', output]]) {
    assert.throws(() => parseBuildOptions(args));
  }
});

test('release manifest inventories every payload byte and records exact provenance', async t => {
  const bundle = await temporary(t);
  await fs.mkdir(path.join(bundle, 'runtime', 'bin'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Open-Murmur.cmd'), 'open\r\n');
  await fs.writeFile(path.join(bundle, 'murmur-tray.exe'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(bundle, 'runtime', 'bin', 'murmur-svc.exe'), Buffer.from([3, 4]));
  const manifest = await writeReleaseManifest(bundle, {
    version: '2.10.0', sourceCommit: 'a'.repeat(40), recipeSha256: 'b'.repeat(64),
    runtimeRecipeSha256: 'c'.repeat(64), runtimeManifestSha256: 'd'.repeat(64),
  });
  assert.equal(manifest.schema, 'murmur.windows-bundle/1');
  assert.equal(manifest.declaredVersion, '2.10.0');
  assert.equal(manifest.sourceCommit, 'a'.repeat(40));
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'Open-Murmur.cmd', 'murmur-tray.exe', 'runtime/bin/murmur-svc.exe',
  ].sort());
  assert.equal(manifest.files['murmur-tray.exe'].size, 3);
  assert.match(manifest.files['murmur-tray.exe'].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.native['murmur-tray.exe'], {
    component: 'windows-tray', version: '2.10.0', sourceCommit: 'a'.repeat(40),
  });
  const written = JSON.parse(await fs.readFile(path.join(bundle, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(written, manifest);
  assert.equal(Object.hasOwn(written.files, 'release-manifest.json'), false);
});

test('manifest and ZIP creation reject symlinks', async t => {
  const bundle = await temporary(t);
  await fs.writeFile(path.join(bundle, 'payload'), 'data');
  await fs.symlink(path.join(bundle, 'payload'), path.join(bundle, 'alias'));
  const metadata = { version: '2.10.0', sourceCommit: 'a'.repeat(40), recipeSha256: 'b'.repeat(64),
    runtimeRecipeSha256: 'c'.repeat(64), runtimeManifestSha256: 'd'.repeat(64) };
  await assert.rejects(writeReleaseManifest(bundle, metadata), /symbolic link/);
  await assert.rejects(writeZip(bundle, path.join(path.dirname(bundle), 'bad.zip'), ''), /symbolic link/);
});

test('root-layout ZIP is deterministic and publication refuses an existing destination', async t => {
  const dir = await temporary(t);
  const bundle = path.join(dir, 'bundle'); await fs.mkdir(bundle);
  await fs.writeFile(path.join(bundle, 'Open-Murmur.cmd'), 'open\r\n');
  const first = path.join(dir, 'first.zip'), second = path.join(dir, 'second.zip');
  await writeZip(bundle, first, ''); await writeZip(bundle, second, '');
  assert.deepEqual(await fs.readFile(first), await fs.readFile(second));
  assert.match((await fs.readFile(first)).toString('latin1'), /Open-Murmur\.cmd/);
  assert.doesNotMatch((await fs.readFile(first)).toString('latin1'), /runtime\/Open-Murmur\.cmd/);
  const legacy = path.join(dir, 'legacy.zip'); await writeZip(bundle, legacy);
  assert.match((await fs.readFile(legacy)).toString('latin1'), /runtime\/Open-Murmur\.cmd/);

  const prepared = path.join(dir, 'prepared'); await fs.mkdir(prepared);
  await fs.writeFile(path.join(prepared, 'artifact'), 'complete');
  const output = path.join(dir, 'output'); await fs.mkdir(output);
  await assert.rejects(publishPrepared(prepared, output), /already exists/);
  assert.deepEqual(await fs.readdir(output), []);
});
