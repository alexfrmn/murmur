#!/usr/bin/env node
// Release producer for the complete Windows companion. Recipients need only Node.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stageRuntime, writeZip } from './build-runtime-bundle.mjs';

const HERE = fileURLToPath(import.meta.url);
const RUNTIME_RECIPE = path.join(path.dirname(HERE), 'build-runtime-bundle.mjs');
const MANIFEST_NAME = 'release-manifest.json';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function absent(file) {
  try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Output already exists: ${file}`);
}

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

async function copyRegularFile(source, target) {
  const stat = await fs.lstat(source);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${source}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  await fs.chmod(target, stat.mode & 0o111 ? 0o755 : 0o644);
}

export function parseBuildOptions(args) {
  const options = {};
  if (args.length % 2 !== 0) throw new Error('Usage: node scripts/build-windows-bundle.mjs --ref COMMIT --out NEW_ABSOLUTE_DIRECTORY');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--ref', '--out'].includes(key) || !value || Object.hasOwn(options, key)) {
      throw new Error('Usage: node scripts/build-windows-bundle.mjs --ref COMMIT --out NEW_ABSOLUTE_DIRECTORY');
    }
    options[key] = value;
  }
  if (!options['--out'] || !path.isAbsolute(options['--out'])) throw new Error('--out must be a new absolute directory');
  return { ref: options['--ref'] ?? 'HEAD', output: path.resolve(options['--out']) };
}

function validateMetadata(metadata) {
  if (!VERSION_PATTERN.test(metadata.version ?? '')) throw new Error('Root product version must be stable three-component SemVer');
  if (!COMMIT_PATTERN.test(metadata.sourceCommit ?? '')) throw new Error('Exact source commit is required');
  for (const key of ['recipeSha256', 'runtimeRecipeSha256', 'runtimeManifestSha256']) {
    if (!SHA256_PATTERN.test(metadata[key] ?? '')) throw new Error(`Invalid ${key}`);
  }
}

export async function writeReleaseManifest(bundle, metadata) {
  validateMetadata(metadata);
  const target = path.join(bundle, MANIFEST_NAME);
  await absent(target);
  const inventory = {};
  for (const file of await files(bundle)) {
    const bytes = await fs.readFile(path.join(bundle, file));
    inventory[file] = { sha256: hash(bytes), size: bytes.length };
  }
  const manifest = {
    schema: 'murmur.windows-bundle/1',
    declaredVersion: metadata.version,
    sourceCommit: metadata.sourceCommit,
    platform: 'windows',
    architecture: 'x64',
    recipeSha256: metadata.recipeSha256,
    runtime: {
      manifestSha256: metadata.runtimeManifestSha256,
      recipeSha256: metadata.runtimeRecipeSha256,
    },
    native: {
      'murmur-tray.exe': { component: 'windows-tray', version: metadata.version, sourceCommit: metadata.sourceCommit },
      'runtime/bin/murmur-svc.exe': { component: 'windows-service', version: metadata.version, sourceCommit: metadata.sourceCommit },
    },
    inventoryScope: `all regular payload files except ${MANIFEST_NAME}`,
    files: inventory,
  };
  await fs.writeFile(target, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  return manifest;
}

export async function publishPrepared(prepared, output) {
  await absent(output);
  const names = await files(prepared);
  await fs.mkdir(output);
  try {
    for (const name of names) await copyRegularFile(path.join(prepared, name), path.join(output, name));
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

function run(program, args, options = {}) {
  return execFileSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
}

function checkNativeVersion(executable, expected) {
  const raw = run(executable, ['--version'], { timeout: 10_000 }).trim();
  let actual;
  try { actual = JSON.parse(raw); } catch { throw new Error(`${expected.component} --version did not return JSON`); }
  const wanted = { schema: 'murmur.native-version/1', product: 'Murmur', component: expected.component,
    version: expected.version, sourceCommit: expected.sourceCommit };
  for (const [key, value] of Object.entries(wanted)) {
    if (actual[key] !== value) throw new Error(`${expected.component} --version ${key} does not match the release`);
  }
}

async function assertCommittedRecipe(repository, commit, file, relative) {
  const local = await fs.readFile(file);
  const committed = execFileSync('git', ['show', `${commit}:${relative}`], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
  if (hash(local) !== hash(committed)) throw new Error(`${relative} must match the selected source commit; commit changes before packaging`);
  return hash(local);
}

async function buildNative(source, bundle, version, commit) {
  const environment = { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0',
    GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOFLAGS: '' };
  const common = `-s -w -X=main.releaseVersion=${version} -X=main.releaseCommit=${commit}`;
  const targets = [
    { directory: 'spikes/windows-tray-go', output: 'murmur-tray.exe', component: 'windows-tray', ldflags: `-H=windowsgui ${common}` },
    { directory: 'spikes/windows-service-go', output: 'runtime/bin/murmur-svc.exe', component: 'windows-service', ldflags: common },
  ];
  for (const target of targets) {
    const output = path.join(bundle, target.output); await fs.mkdir(path.dirname(output), { recursive: true });
    run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags', target.ldflags, '-o', output, '.'], {
      cwd: path.join(source, target.directory), env: environment, stdio: 'inherit',
    });
    if (!(await fs.lstat(output)).isFile()) throw new Error(`Go did not produce ${target.output}`);
    checkNativeVersion(output, { component: target.component, version, sourceCommit: commit });
  }
}

export async function buildWindowsBundle({ ref, output }) {
  if (!path.isAbsolute(output ?? '')) throw new Error('--out must be a new absolute directory');
  await absent(output);
  if (process.platform !== 'win32') throw new Error('The release bundle must be produced on Windows so both native --version contracts can be executed');
  const repository = path.resolve(path.dirname(HERE), '..');
  const git = args => run('git', args, { cwd: repository }).trim();
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!COMMIT_PATTERN.test(commit)) throw new Error('Git did not resolve an exact source commit');
  const recipeSha256 = await assertCommittedRecipe(repository, commit, HERE, 'scripts/build-windows-bundle.mjs');
  const runtimeRecipeSha256 = await assertCommittedRecipe(repository, commit, RUNTIME_RECIPE, 'scripts/build-runtime-bundle.mjs');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-windows-build-'));
  try {
    const source = path.join(temporary, 'source'); await fs.mkdir(source);
    run('git', ['archive', '--format=tar', '-o', path.join(temporary, 'source.tar'), commit], { cwd: repository });
    run('tar', ['-xf', path.join(temporary, 'source.tar'), '-C', source]);
    const root = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'));
    if (root.name !== 'murmur' || !VERSION_PATTERN.test(root.version ?? '')) throw new Error('Selected root package has no stable Murmur product version');
    if (lock.version !== root.version || lock.packages?.['']?.version !== root.version) throw new Error('Root package and lockfile product versions differ');
    const environment = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, env: environment, stdio: 'inherit' });
    run('npm', ['run', 'build'], { cwd: source, env: environment, stdio: 'inherit' });

    const bundle = path.join(temporary, 'bundle'); await fs.mkdir(bundle);
    const runtime = path.join(bundle, 'runtime');
    const runtimeManifest = await stageRuntime(source, runtime, { sourceCommit: commit, recipeSha256: runtimeRecipeSha256 });
    if (runtimeManifest.declaredVersion !== root.version || runtimeManifest.sourceCommit !== commit ||
        runtimeManifest.recipeSha256 !== runtimeRecipeSha256) throw new Error('Portable runtime provenance differs from the selected release');
    for (const name of ['Open-Murmur.cmd', 'Open-Murmur.ps1', 'README-Windows.md']) {
      await copyRegularFile(path.join(source, 'apps/windows-tray/packaging', name), path.join(bundle, name));
    }
    await buildNative(source, bundle, root.version, commit);
    const runtimeManifestSha256 = hash(await fs.readFile(path.join(runtime, 'runtime-manifest.json')));
    const manifest = await writeReleaseManifest(bundle, { version: root.version, sourceCommit: commit, recipeSha256,
      runtimeRecipeSha256, runtimeManifestSha256 });

    const archive = `Murmur-Windows-${root.version}-x64.zip`;
    const prepared = path.join(temporary, 'prepared'); await fs.mkdir(prepared);
    await writeZip(bundle, path.join(prepared, archive), '');
    await copyRegularFile(path.join(bundle, MANIFEST_NAME), path.join(prepared, MANIFEST_NAME));
    const archiveHash = hash(await fs.readFile(path.join(prepared, archive)));
    const manifestHash = hash(await fs.readFile(path.join(prepared, MANIFEST_NAME)));
    await fs.writeFile(path.join(prepared, 'SHA256SUMS.txt'), `${archiveHash}  ${archive}\n${manifestHash}  ${MANIFEST_NAME}\n`, { flag: 'wx' });
    await publishPrepared(prepared, output);
    return { sourceCommit: commit, declaredVersion: root.version, output, archive, files: Object.keys(manifest.files).length };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main(args) {
  const result = await buildWindowsBundle(parseBuildOptions(args));
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
