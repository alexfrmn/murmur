import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseBuildOptions,
  resolveNpmCli,
  writeReleaseManifest,
  publishPrepared,
} from '../scripts/build-windows-bundle.mjs';
import { writeZip } from '../scripts/build-runtime-bundle.mjs';
import { verifyWindowsBundle } from '../scripts/check-windows-bundle.mjs';

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

test('npm runs through a validated npm-cli.js beside the selected Node executable', async t => {
  const dir = await temporary(t);
  const node = path.join(dir, 'node.exe'); await fs.writeFile(node, 'node');
  const adjacent = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await fs.mkdir(path.dirname(adjacent), { recursive: true }); await fs.writeFile(adjacent, 'cli');
  assert.equal(await resolveNpmCli(node, {}), adjacent);
  const explicit = path.join(dir, 'other', 'npm-cli.js');
  await fs.mkdir(path.dirname(explicit), { recursive: true }); await fs.writeFile(explicit, 'explicit');
  assert.equal(await resolveNpmCli(node, { npm_execpath: explicit }), explicit);
  await assert.rejects(resolveNpmCli(node, { npm_execpath: 'relative/npm-cli.js' }), /absolute/);
  const linked = path.join(dir, 'linked', 'npm-cli.js'); await fs.mkdir(path.dirname(linked));
  await fs.symlink(explicit, linked);
  await assert.rejects(resolveNpmCli(node, { npm_execpath: linked }), /regular file/);
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
    checkerSha256: 'e'.repeat(64), buildNode: '22.13.0', buildGo: 'go version go1.24.0 windows/amd64',
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
    runtimeRecipeSha256: 'c'.repeat(64), runtimeManifestSha256: 'd'.repeat(64),
    checkerSha256: 'e'.repeat(64), buildNode: '22.13.0', buildGo: 'go version go1.24.0 windows/amd64' };
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

test('Windows checker accepts the declared service overlay and rejects any undeclared byte', async t => {
  const bundle = await temporary(t);
  await fs.mkdir(path.join(bundle, 'runtime', 'bin'), { recursive: true });
  const payload = {
    'Open-Murmur.cmd': 'cmd', 'Open-Murmur.ps1': 'ps1', 'README-Windows.md': 'readme',
    'check-windows-bundle.mjs': 'checker', 'murmur-tray.exe': 'tray', 'runtime/package.json': 'package',
    'runtime/bin/murmur-svc.exe': 'service', 'murmur.ico': 'icon',
  };
  for (const [name, contents] of Object.entries(payload)) {
    await fs.mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
    await fs.writeFile(path.join(bundle, name), contents);
  }
  const runtimeFile = await fs.readFile(path.join(bundle, 'runtime', 'package.json'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const runtimeManifest = { schema: 'murmur.runtime-bundle/1', declaredVersion: '2.10.0',
    sourceCommit: 'a'.repeat(40), recipeSha256: 'c'.repeat(64),
    files: { 'package.json': { sha256: digest(runtimeFile), size: runtimeFile.length } } };
  await fs.writeFile(path.join(bundle, 'runtime', 'runtime-manifest.json'), JSON.stringify(runtimeManifest) + '\n');
  const runtimeManifestBytes = await fs.readFile(path.join(bundle, 'runtime', 'runtime-manifest.json'));
  const checkerBytes = await fs.readFile(path.join(bundle, 'check-windows-bundle.mjs'));
  await writeReleaseManifest(bundle, { version: '2.10.0', sourceCommit: 'a'.repeat(40),
    recipeSha256: 'b'.repeat(64), runtimeRecipeSha256: 'c'.repeat(64),
    runtimeManifestSha256: digest(runtimeManifestBytes), checkerSha256: digest(checkerBytes), buildNode: '22.13.0',
    buildGo: 'go version go1.24.0 windows/amd64' });
  const result = await verifyWindowsBundle(bundle, { executeNative: false });
  assert.equal(result.declaredVersion, '2.10.0');
  assert.equal(result.files, Object.keys(payload).length + 1);
  await fs.writeFile(path.join(bundle, 'runtime', 'unexpected.cache'), 'extra');
  await assert.rejects(verifyWindowsBundle(bundle, { executeNative: false }), /Unmanifested bundle file/);
});
