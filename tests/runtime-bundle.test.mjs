import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stageRuntime, writeZip } from '../scripts/build-runtime-bundle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur bundle '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('staged runtime is self-contained, uses locked dependencies and works outside checkout', async t => {
  const dir = await temporary(t);
  const output = path.join(dir, 'runtime');
  const manifest = await stageRuntime(root, output, { sourceCommit: 'a'.repeat(40) });
  assert.equal(manifest.sourceCommit, 'a'.repeat(40));
  assert.ok(manifest.dependencies.some(x => x.name === 'nkeys.js'));
  assert.ok(manifest.dependencies.some(x => x.name === '@iarna/toml'));
  assert.ok(!manifest.dependencies.some(x => x.name === 'better-sqlite3'));
  assert.ok(!Object.keys(manifest.files).some(x => /tsbuildinfo|__pycache__|\.node$/.test(x)));
  assert.ok(Object.hasOwn(manifest.files, 'plugins/claude-code/.claude-plugin/plugin.json'));
  assert.ok(Object.hasOwn(manifest.files, 'plugins/claude-code/.mcp.json'));
  assert.ok(Object.hasOwn(manifest.files, 'plugins/claude-code/scripts/statusline.mjs'));
  const doctorProtocol = await import(pathToFileURL(path.join(output, 'scripts/doctor-protocol.mjs')));
  assert.equal(typeof doctorProtocol.createDoctorResponder, 'function');
  const contacts = await import(pathToFileURL(path.join(output, 'scripts/daemon-contacts.mjs')));
  assert.equal(typeof contacts.createDaemonContacts, 'function');
  for (const file of Object.keys(manifest.files)) assert.equal((await fs.lstat(path.join(output, file))).isSymbolicLink(), false);
  const cli = path.join(output, 'packages/setup/bin/murmur.mjs');
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    cwd: dir, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', MURMUR_UPDATE_CHECK: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }));
  assert.equal(run(['version']).version, JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version);
  const profile = path.join(dir, 'private profile');
  assert.equal(run(['init', '--data-dir', profile, '--agent-id', 'bundle-test', '--broker-url', 'nats://127.0.0.1:4222']).agentId, 'bundle-test');
  assert.equal(run(['status', '--data-dir', profile]).agentId, 'bundle-test');
  const first = path.join(dir, 'first.zip'), second = path.join(dir, 'second.zip');
  await writeZip(output, first); await writeZip(output, second);
  assert.deepEqual(await fs.readFile(first), await fs.readFile(second));
});

test('missing compiled entry fails without leaving a half-ready output', async t => {
  const dir = await temporary(t);
  const source = path.join(dir, 'source');
  await fs.mkdir(source);
  await fs.copyFile(path.join(root, 'package.json'), path.join(source, 'package.json'));
  await fs.copyFile(path.join(root, 'package-lock.json'), path.join(source, 'package-lock.json'));
  const output = path.join(dir, 'runtime');
  await assert.rejects(stageRuntime(source, output, { sourceCommit: 'b'.repeat(40) }));
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('archive writer refuses symbolic links rather than shipping Windows-unpackable entries', async t => {
  const dir = await temporary(t);
  const source = path.join(dir, 'runtime'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'real.txt'), 'data');
  // Junctions exercise the same rule without Windows developer-mode privileges.
  await fs.symlink(source, path.join(source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeZip(source, path.join(dir, 'bad.zip')), /symbolic link/);
});
