#!/usr/bin/env node
// Release producer (Git + npm + tar required). Consumers need only external Node.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const HERE = fileURLToPath(import.meta.url);
const WORKSPACES = ['core', 'security', 'broker-nats', 'broker-ws', 'mcp-server', 'setup'];
const SCRIPTS = ['murmur-daemon.mjs', 'murmur-shell-send.mjs', 'runtime-capability.mjs',
  'notify-router.mjs', 'codex-app-server-wake.mjs', 'murmur-jetstream-advisory.mjs',
  'wake-monitor.mjs', 'lease.mjs', 'secure-state.mjs', 'daemon-observation.mjs', 'ack-security.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const posix = value => value.split(path.sep).join('/');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
async function absent(file) {
  try { await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw new Error(`Output already exists: ${file}`);
}
async function files(dir, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Runtime must not contain a symbolic link: ${name}`);
    if (entry.isDirectory()) result.push(...await files(path.join(dir, entry.name), name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported runtime file: ${name}`);
  }
  return result;
}
async function copyFile(source, target) {
  const stat = await fs.lstat(source);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${source}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  await fs.chmod(target, stat.mode & 0o111 ? 0o755 : 0o644);
}
async function copyTree(source, target, allow = () => true) {
  for (const file of await files(source)) if (allow(file)) await copyFile(path.join(source, file), path.join(target, file));
}
async function resolveDependency(root, from, name) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error(`Invalid dependency name: ${name}`);
  for (let dir = from; inside(root, dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    try { await fs.access(path.join(candidate, 'package.json')); return candidate; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (dir === root) break;
  }
  throw new Error(`Missing runtime dependency ${name} from ${from}`);
}

// Production calls this only on a fresh git archive after npm ci + build. The
// separate function allows tests to exercise staging without rebuilding the repo.
export async function stageRuntime(source, output, { sourceCommit, recipeSha256 = null } = {}) {
  source = await fs.realpath(source); output = path.resolve(output);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('Exact source commit is required');
  if (inside(source, output)) throw new Error('Runtime output must be outside the source tree');
  await absent(output);
  const staging = await fs.mkdtemp(path.join(path.dirname(output), '.murmur-runtime-'));
  try {
    const root = await json(path.join(source, 'package.json'));
    const lockBytes = await fs.readFile(path.join(source, 'package-lock.json'));
    const lock = JSON.parse(lockBytes);
    const dependencies = [], seen = new Set();
    async function dependency(from, name) {
      const located = await resolveDependency(source, from, name);
      const relative = posix(path.relative(source, located));
      if (seen.has(relative)) return;
      seen.add(relative);
      const real = await fs.realpath(located);
      if (!inside(source, real)) throw new Error(`Dependency escapes source: ${name}`);
      const pkg = await json(path.join(real, 'package.json'));
      const locked = lock.packages?.[relative];
      if (pkg.name !== name || !locked) throw new Error(`Dependency is not locked: ${name}`);
      if (locked.link) {
        const workspace = WORKSPACES.find(w => name === `@murmurv2/${w}`);
        if (!workspace || real !== path.join(source, 'packages', workspace)) throw new Error(`Unexpected workspace link: ${name}`);
        await copyTree(path.join(staging, 'packages', workspace), path.join(staging, relative));
      } else {
        if (locked.version !== pkg.version || !locked.integrity) throw new Error(`Dependency differs from lock: ${name}`);
        // npm ci verified tarball integrity. Copy this package without nested
        // dependencies, then follow its declared production graph recursively.
        const entries = await fs.readdir(real);
        for (const entry of entries.sort()) {
          if (entry === 'node_modules') continue;
          const src = path.join(real, entry), dst = path.join(staging, relative, entry);
          const stat = await fs.lstat(src);
          if (stat.isDirectory()) await copyTree(src, dst);
          else await copyFile(src, dst);
        }
        dependencies.push({ name, version: pkg.version, path: relative, integrity: locked.integrity });
      }
      for (const child of Object.keys(pkg.dependencies ?? {}).sort()) await dependency(real, child);
      for (const child of Object.keys(pkg.peerDependencies ?? {})) {
        if (!pkg.peerDependenciesMeta?.[child]?.optional) await dependency(real, child);
      }
      for (const child of Object.keys(pkg.optionalDependencies ?? {}).sort()) await dependency(real, child);
    }
    // Preserve the release version and Node policy, without advertising omitted
    // developer commands or unrelated integrations in this runtime-only manifest.
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: root.name, private: true,
      version: root.version, engines: root.engines, description: 'Prebuilt Murmur CLI, daemon and MCP runtime' }, null, 2) + '\n');
    await copyFile(path.join(source, 'LICENSE'), path.join(staging, 'LICENSE'));
    for (const workspace of WORKSPACES) {
      const rel = `packages/${workspace}`;
      await copyFile(path.join(source, rel, 'package.json'), path.join(staging, rel, 'package.json'));
      await copyTree(path.join(source, rel, 'dist/src'), path.join(staging, rel, 'dist/src'), file => /\.(?:js|json)$/.test(file));
      await fs.access(path.join(staging, rel, 'dist/src', workspace === 'setup' ? 'cli.js' : 'index.js'));
    }
    await copyTree(path.join(source, 'packages/core/schema'), path.join(staging, 'packages/core/schema'));
    await copyFile(path.join(source, 'packages/setup/bin/murmur.mjs'), path.join(staging, 'packages/setup/bin/murmur.mjs'));
    for (const script of SCRIPTS) await copyFile(path.join(source, 'scripts', script), path.join(staging, 'scripts', script));
    for (const workspace of WORKSPACES) await dependency(source, `@murmurv2/${workspace}`);
    // ws is also a direct dependency of the daemon's Codex wake transport.
    await dependency(source, 'ws');
    const inventory = {};
    for (const file of await files(staging)) {
      if (/\.node$|\.tsbuildinfo$|(?:^|\/)__pycache__(?:\/|$)/.test(file)) throw new Error(`Unsupported runtime artifact: ${file}`);
      const bytes = await fs.readFile(path.join(staging, file));
      inventory[file] = { sha256: hash(bytes), size: bytes.length };
    }
    const manifest = { schema: 'murmur.runtime-bundle/1', sourceCommit, declaredVersion: root.version,
      sourceLockSha256: hash(lockBytes), recipeSha256, buildNode: process.versions.node,
      workspaces: WORKSPACES, dependencies: dependencies.sort((a, b) => a.path.localeCompare(b.path, 'en')),
      files: inventory };
    await fs.writeFile(path.join(staging, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.rename(staging, output);
    return manifest;
  } catch (e) { await fs.rm(staging, { recursive: true, force: true }); throw e; }
}

// Standard ZIP entries with ordinary files, fixed DOS epoch and Unix modes. No
// symlink privileges, third-party archiver or build tools are needed to extract.
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export async function writeZip(root, output) {
  await absent(output);
  const local = [], central = []; let offset = 0;
  for (const file of await files(root)) {
    const name = Buffer.from(`runtime/${file}`), bytes = await fs.readFile(path.join(root, file)), data = deflateRawSync(bytes, { level: 9 });
    if (name.length > 65535 || offset + data.length > 0xffffffff) throw new Error('Runtime exceeds ZIP32 limits');
    const crc = crc32(bytes), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 30);
    const stat = await fs.stat(path.join(root, file));
    directory.writeUInt32LE(((0o100000 | (stat.mode & 0o111 ? 0o755 : 0o644)) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  if (central.length / 2 > 65535) throw new Error('Too many ZIP entries');
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(central.reduce((n, b) => n + b.length, 0), 12); end.writeUInt32LE(offset, 16);
  await fs.writeFile(output, Buffer.concat([...local, ...central, end]), { flag: 'wx' });
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--ref', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/build-runtime-bundle.mjs --ref COMMIT --out NEW_ABSOLUTE_DIRECTORY');
    options[args[i]] = args[i + 1];
  }
  if (!options['--out'] || !path.isAbsolute(options['--out'])) throw new Error('--out must be a new absolute directory');
  const output = path.resolve(options['--out']); await absent(output);
  const repository = path.resolve(path.dirname(HERE), '..');
  const git = argv => execFileSync('git', argv, { cwd: repository, encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', '--verify', `${options['--ref'] ?? 'HEAD'}^{commit}`]);
  if (hash(await fs.readFile(HERE)) !== hash(execFileSync('git', ['show', `${commit}:scripts/build-runtime-bundle.mjs`], { cwd: repository }))) {
    throw new Error('Builder must match the selected source commit; commit changes before packaging');
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-runtime-build-'));
  try {
    const source = path.join(temp, 'source'); await fs.mkdir(source);
    execFileSync('git', ['archive', '--format=tar', '-o', path.join(temp, 'source.tar'), commit], { cwd: repository });
    execFileSync('tar', ['-xf', path.join(temp, 'source.tar'), '-C', source]);
    const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, env, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build'], { cwd: source, env, stdio: 'inherit' });
    const runtime = path.join(temp, 'runtime');
    const manifest = await stageRuntime(source, runtime, { sourceCommit: commit, recipeSha256: hash(await fs.readFile(HERE)) });
    const archive = `murmur-runtime-${manifest.declaredVersion}.zip`;
    const prepared = path.join(temp, 'prepared'); await fs.mkdir(prepared);
    await writeZip(runtime, path.join(prepared, archive));
    await fs.copyFile(path.join(runtime, 'runtime-manifest.json'), path.join(prepared, 'runtime-manifest.json'));
    await fs.writeFile(path.join(prepared, 'SHA256SUMS.txt'), `${hash(await fs.readFile(path.join(prepared, archive)))}  ${archive}\n`);
    // Cross-device output is common (/tmp -> workspace); publish only completed files.
    await fs.mkdir(output); await fs.cp(prepared, output, { recursive: true, errorOnExist: true, force: false });
    console.log(JSON.stringify({ sourceCommit: commit, output, archive, dependencies: manifest.dependencies.length, files: Object.keys(manifest.files).length }));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === HERE) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
