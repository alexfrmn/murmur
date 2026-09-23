#!/usr/bin/env node
// Validate every tarball before the first publish. An explicit registry is
// required; without --publish this command only creates local artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { runNpm } from './npm-command.mjs';

const HERE = fileURLToPath(import.meta.url);
export function parseOptions(args) {
  const options = { publish: false, skipExisting: false };
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split(/=(.*)/s);
    if (key === '--publish' && inline === undefined) options.publish = true;
    else if (key === '--skip-existing' && inline === undefined) options.skipExisting = true;
    else if (key === '--dry-run' && inline === undefined) { /* default */ }
    else if (['--registry', '--out', '--otp'].includes(key)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
      options[key.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!options.registry) throw new Error('--registry URL is required; no implicit npmjs publication');
  const url = new URL(options.registry);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid registry URL');
  options.registry = url.href;
  if (options.out && !path.isAbsolute(options.out)) throw new Error('--out must be absolute');
  if (options.otp && !/^\d{6,10}$/.test(options.otp)) throw new Error('Invalid OTP format');
  if (args.includes('--dry-run') && options.publish) throw new Error('--dry-run and --publish conflict');
  return options;
}

export function publicationOrder(packages) {
  const all = new Map(packages.map(pkg => [pkg.name, pkg]));
  const visited = new Set(), visiting = new Set(), ordered = [];
  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) throw new Error(`Dependency cycle: ${pkg.name}`);
    if (pkg.private === true || !/^@murmurv2\/[a-z0-9-]+$/.test(pkg.name) || !semver.valid(pkg.version)) throw new Error(`Not publishable: ${pkg.name}`);
    visiting.add(pkg.name);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (typeof range !== 'string' || !semver.validRange(range)) throw new Error(`Non-registry dependency: ${pkg.name} -> ${name}`);
        if (!name.startsWith('@murmurv2/')) continue;
        const target = all.get(name);
        if (!target || target.private === true || !semver.satisfies(target.version, range)) throw new Error(`Invalid public dependency: ${pkg.name} -> ${name}@${range}`);
        visit(target);
      }
    }
    visiting.delete(pkg.name); visited.add(pkg.name); ordered.push(pkg);
  }
  for (const pkg of packages.filter(p => p.private !== true).sort((a, b) => a.name.localeCompare(b.name))) visit(pkg);
  return ordered;
}

export function validatePack(pkg, packed) {
  if (packed.name !== pkg.name || packed.version !== pkg.version || path.basename(packed.filename ?? '') !== packed.filename) throw new Error(`Invalid pack metadata: ${pkg.name}`);
  const files = packed.files?.map(f => f.path) ?? [];
  const required = pkg.name === '@murmurv2/cli'
    ? ['bin/murmur-npm.mjs', 'runtime/package.json', 'runtime/npm-runtime-manifest.json',
      'runtime/packages/setup/bin/murmur.mjs', 'runtime/packages/setup/dist/src/cli.js',
      'runtime/packages/setup/dist/src/index.js', 'runtime/packages/setup/dist/src/index.d.ts',
      'runtime/packages/mcp-server/dist/src/index.js', 'runtime/scripts/murmur-daemon.mjs',
      'runtime/scripts/secure-state.mjs', 'runtime/bin/murmur-svc.exe']
    : ['dist/src/index.js', 'dist/src/index.d.ts'];
  for (const name of ['package.json', 'LICENSE', ...required]) if (!files.includes(name)) throw new Error(`${pkg.name}: tarball missing ${name}`);
  for (const name of files) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') ||
      /(?:^|\/)(?:node_modules|\.git|\.env[^/]*|\.data[^/]*|__pycache__)(?:\/|$)|(?:agent-config|invite|reply)\.(?:json|txt)$|\.(?:db|sqlite|tsbuildinfo|map|pem|key|node)$/.test(name)) {
      throw new Error(`${pkg.name}: forbidden packed file ${name}`);
    }
  }
}

// The runner is injectable to test failure/ordering without a live registry.
export async function packThenPublish(packages, options, run = runNpm) {
  const packed = [];
  for (const pkg of publicationOrder(packages)) {
    const output = run(['pack', '--workspace', pkg.name, '--pack-destination', options.out, '--json'], { cwd: options.root });
    const info = JSON.parse(output)[0];
    validatePack(pkg, info);
    const file = path.join(options.out, info.filename);
    const integrity = 'sha512-' + createHash('sha512').update(await fs.readFile(file)).digest('base64');
    if (info.integrity !== integrity) throw new Error(`${pkg.name}: packed bytes do not match npm integrity`);
    packed.push({ name: pkg.name, version: pkg.version, file, integrity, size: info.size, files: info.files.length });
  }
  if (options.beforePublish) await options.beforePublish(packed);
  // Check every registry version before the first side effect.
  for (const item of packed) {
    if (!options.publish) continue;
    let existing;
    try { existing = JSON.parse(run(['view', `${item.name}@${item.version}`, 'dist.integrity', '--json', '--registry', options.registry], { cwd: options.root })); }
    catch (error) {
      let details;
      try { details = JSON.parse(String(error.stdout)); } catch { /* Unknown errors fail closed. */ }
      if (details?.error?.code !== 'E404') throw error;
    }
    if (existing !== undefined) {
      if (!options.skipExisting || existing !== item.integrity) throw new Error(`${item.name}@${item.version} already exists; changed bytes need a new version`);
      item.skipped = true;
    }
  }
  for (const item of packed) {
    if (!options.publish || item.skipped) continue;
    const args = ['publish', item.file, '--access', 'public', '--registry', options.registry, '--ignore-scripts'];
    if (options.otp) args.push(`--otp=${options.otp}`);
    run(args, { cwd: options.root });
    const observed = JSON.parse(run(['view', `${item.name}@${item.version}`, 'dist.integrity', '--json', '--registry', options.registry], { cwd: options.root }));
    if (observed !== item.integrity) throw new Error(`${item.name}: registry integrity differs after publication`);
    item.published = true;
  }
  return packed;
}

async function main(args) {
  const options = parseOptions(args);
  const root = path.resolve(path.dirname(HERE), '..');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  function assertClean() {
    if (git(['status', '--porcelain']) || git(['rev-parse', 'HEAD']) !== commit) throw new Error('Publish only a clean, unchanged source commit');
  }
  if (options.publish) assertClean();
  execFileSync(process.execPath, [path.join(root, 'scripts/prep-publish.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
  runNpm(['run', 'build'], { cwd: root });
  const out = options.out ?? await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-npm-publish-'));
  if (options.out) await fs.mkdir(out, { recursive: false });
  const packages = [];
  for (const dir of await fs.readdir(path.join(root, 'packages'))) {
    try { packages.push(JSON.parse(await fs.readFile(path.join(root, 'packages', dir, 'package.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const result = await packThenPublish(packages, { ...options, root, out, beforePublish: options.publish ? assertClean : undefined });
  const proof = { schema: 'murmur.npm-publication/1', sourceCommit: commit, sourceDirty: !!git(['status', '--porcelain']), registry: options.registry, publish: options.publish, packages: result };
  await fs.writeFile(path.join(out, 'publication.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ ...proof, output: out }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === HERE) main(process.argv.slice(2)).catch(e => {
  // Never echo npm auth headers or an OTP-containing command line.
  const subprocess = e && (Object.hasOwn(e, 'status') || Object.hasOwn(e, 'stdout') || Object.hasOwn(e, 'spawnargs') || Object.hasOwn(e, 'cmd'));
  console.error(e instanceof Error && !subprocess ? e.message : 'npm command failed; inspect the local npm log'); process.exitCode = 1;
});
