#!/usr/bin/env node
// Dependency-free verifier for an extracted Windows companion bundle.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = fileURLToPath(import.meta.url);
const MANIFEST_NAME = 'release-manifest.json';
const REQUIRED = ['Open-Murmur.cmd', 'Open-Murmur.ps1', 'README-Windows.md', 'check-windows-bundle.mjs', 'murmur-tray.exe', 'murmur.ico',
  'runtime/runtime-manifest.json', 'runtime/packages/setup/bin/murmur.mjs', 'runtime/bin/murmur-svc.exe'];
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function files(root, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Bundle must not contain a symbolic link: ${name}`);
    if (entry.isDirectory()) result.push(...await files(path.join(root, entry.name), name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported bundle file: ${name}`);
  }
  return result;
}

async function readJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`Expected a bounded regular JSON file: ${file}`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function verifyNativeDeclaration(manifest, file, component) {
  const value = manifest.native?.[file];
  if (value?.component !== component || value.version !== manifest.declaredVersion || value.sourceCommit !== manifest.sourceCommit) {
    throw new Error(`Invalid native declaration: ${file}`);
  }
}

function executeNativeVersion(executable, manifest, component) {
  if (process.platform !== 'win32') throw new Error('Native version execution requires Windows');
  let value;
  try {
    value = JSON.parse(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim());
  } catch (error) { throw new Error(`${component} --version verification failed: ${error.message}`); }
  const expected = { schema: 'murmur.native-version/1', product: 'Murmur', component,
    version: manifest.declaredVersion, sourceCommit: manifest.sourceCommit };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`${component} --version ${key} differs from the release manifest`);
  }
}

function executeRuntimeVersion(root, manifest) {
  // Match Open-Murmur.ps1's entry point; a workspace copy below node_modules
  // has a different relative-import base and is not a launcher entry point.
  const cli = path.join(root, 'runtime', 'packages', 'setup', 'bin', 'murmur.mjs');
  let value;
  try {
    value = JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, 'version', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', MURMUR_UPDATE_CHECK: '0' },
    }).trim());
  } catch {
    throw new Error('Runtime CLI version verification failed: version --json must complete with a JSON contract');
  }
  const expected = { schema: 'murmur.version/1', product: 'Murmur', version: manifest.declaredVersion };
  for (const [key, wanted] of Object.entries(expected)) {
    if (value?.[key] !== wanted) throw new Error(`Runtime CLI ${key} differs from the release manifest`);
  }
}

function validateInventoryEntry(file, entry) {
  if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe manifest path: ${file}`);
  }
  if (!entry || !SHA256_PATTERN.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`Invalid manifest inventory entry: ${file}`);
  }
}

export async function verifyWindowsBundle(root, { executeNative = process.platform === 'win32' } = {}) {
  root = await fs.realpath(root);
  const manifestPath = path.join(root, MANIFEST_NAME);
  const manifest = await readJson(manifestPath);
  if (manifest.schema !== 'murmur.windows-bundle/1' || manifest.platform !== 'windows' || manifest.architecture !== 'x64') {
    throw new Error('Invalid Windows release manifest identity');
  }
  if (!VERSION_PATTERN.test(manifest.declaredVersion ?? '') || !COMMIT_PATTERN.test(manifest.sourceCommit ?? '') ||
      !SHA256_PATTERN.test(manifest.recipeSha256 ?? '') || !SHA256_PATTERN.test(manifest.runtime?.recipeSha256 ?? '') ||
      !SHA256_PATTERN.test(manifest.runtime?.manifestSha256 ?? '') || !SHA256_PATTERN.test(manifest.checkerSha256 ?? '')) {
    throw new Error('Invalid Windows release provenance');
  }
  for (const value of [manifest.build?.node, manifest.build?.go]) {
    if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('Invalid Windows build-tool provenance');
    }
  }
  if (!manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') throw new Error('Invalid Windows release inventory');
  const actual = (await files(root)).filter(file => file !== MANIFEST_NAME);
  const declared = Object.keys(manifest.files);
  for (const file of declared) validateInventoryEntry(file, manifest.files[file]);
  for (const file of actual) if (!Object.hasOwn(manifest.files, file)) throw new Error(`Unmanifested bundle file: ${file}`);
  for (const file of declared) {
    if (!actual.includes(file)) throw new Error(`Missing bundle file: ${file}`);
    const bytes = await fs.readFile(path.join(root, file));
    if (bytes.length !== manifest.files[file].size || hash(bytes) !== manifest.files[file].sha256) throw new Error(`Bundle file differs from manifest: ${file}`);
  }
  if (manifest.files['check-windows-bundle.mjs']?.sha256 !== manifest.checkerSha256) throw new Error('Checker hash differs from release provenance');
  for (const file of REQUIRED) if (!actual.includes(file)) throw new Error(`Required bundle file is missing: ${file}`);
  verifyNativeDeclaration(manifest, 'murmur-tray.exe', 'windows-tray');
  verifyNativeDeclaration(manifest, 'runtime/bin/murmur-svc.exe', 'windows-service');

  const runtimePath = path.join(root, 'runtime');
  const runtimeManifestPath = path.join(runtimePath, 'runtime-manifest.json');
  const runtimeManifestBytes = await fs.readFile(runtimeManifestPath);
  if (hash(runtimeManifestBytes) !== manifest.runtime.manifestSha256) throw new Error('Runtime manifest hash differs from release manifest');
  const runtimeManifest = JSON.parse(runtimeManifestBytes.toString('utf8'));
  if (runtimeManifest.schema !== 'murmur.runtime-bundle/1' || runtimeManifest.declaredVersion !== manifest.declaredVersion ||
      runtimeManifest.sourceCommit !== manifest.sourceCommit || runtimeManifest.recipeSha256 !== manifest.runtime.recipeSha256 ||
      !runtimeManifest.files || Array.isArray(runtimeManifest.files)) throw new Error('Portable runtime provenance differs from release manifest');
  const runtimeActual = (await files(runtimePath)).filter(file => file !== 'runtime-manifest.json' && file !== 'bin/murmur-svc.exe');
  for (const file of runtimeActual) if (!Object.hasOwn(runtimeManifest.files, file)) throw new Error(`Unmanifested portable runtime file: ${file}`);
  for (const [file, entry] of Object.entries(runtimeManifest.files)) {
    validateInventoryEntry(file, entry);
    if (!runtimeActual.includes(file)) throw new Error(`Missing portable runtime file: ${file}`);
    const bytes = await fs.readFile(path.join(runtimePath, file));
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`Portable runtime file differs from manifest: ${file}`);
  }
  executeRuntimeVersion(root, manifest);
  if (executeNative) {
    executeNativeVersion(path.join(root, 'murmur-tray.exe'), manifest, 'windows-tray');
    executeNativeVersion(path.join(root, 'runtime', 'bin', 'murmur-svc.exe'), manifest, 'windows-service');
  }
  return { schema: manifest.schema, declaredVersion: manifest.declaredVersion, sourceCommit: manifest.sourceCommit,
    files: actual.length, runtimeVersionExecuted: true, nativeVersionExecuted: executeNative };
}

async function main(args) {
  if (args.length !== 1) throw new Error('Usage: node scripts/check-windows-bundle.mjs EXTRACTED_BUNDLE_DIRECTORY');
  console.log(JSON.stringify(await verifyWindowsBundle(path.resolve(args[0]))));
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
