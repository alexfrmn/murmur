#!/usr/bin/env node
// Stage only executable release inputs. No profile, checkout, node_modules,
// invite, build cache or compiler is needed on the receiving machine.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SCRIPTS } from './build-runtime-bundle.mjs';

const HERE = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));

export async function stageCliRuntime(source, output) {
  const root = await json(path.join(source, 'package.json'));
  const cli = await json(path.join(source, 'packages/setup/package.json'));
  if (cli.name !== '@murmurv2/cli' || cli.private === true || cli.version !== root.version) {
    throw new Error('CLI must be public and its version must match the root release version');
  }
  let sourceCommit = null, sourceDirty = null;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: source, encoding: 'utf8' }).trim();
  } catch { /* Source archives have no git metadata; do not invent provenance. */ }
  const inventory = {};
  await fs.mkdir(output, { recursive: false });
  async function write(relative, bytes, mode = 0o644) {
    await fs.mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    await fs.writeFile(path.join(output, relative), bytes, { mode, flag: 'wx' });
    inventory[relative] = { sha256: hash(bytes), size: Buffer.byteLength(bytes) };
  }
  async function copy(relative, destination = relative) {
    const file = path.join(source, relative), stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error(`CLI input must be a regular file: ${relative}`);
    await write(destination, await fs.readFile(file), stat.mode & 0o111 ? 0o755 : 0o644);
  }
  async function tree(relative, allowed) {
    for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`CLI input must not be a symlink: ${child}`);
      if (entry.isDirectory()) await tree(child, allowed);
      else if (allowed(child)) await copy(child);
    }
  }
  await write('package.json', JSON.stringify({ name: root.name, private: true, version: root.version, engines: root.engines }) + '\n');
  await write('packages/setup/package.json', JSON.stringify({ name: cli.name, private: true, version: cli.version,
    type: 'module', main: 'dist/src/index.js', types: 'dist/src/index.d.ts' }) + '\n');
  await tree('packages/setup/dist/src', file => /\.(?:js|json|d\.ts)$/.test(file));
  await copy('packages/setup/bin/murmur.mjs');
  // The configured client entry remains stable; npm resolves the actual MCP
  // implementation from the declared dependency, not a second bundled copy.
  await write('packages/mcp-server/package.json', '{"type":"module","private":true}\n');
  await write('packages/mcp-server/dist/src/index.js', 'import "@murmurv2/mcp-server";\n');
  for (const file of SCRIPTS) await copy(`scripts/${file}`);
  for (const file of ['.claude-plugin/plugin.json', '.mcp.json', 'scripts/statusline.mjs', 'scripts/configure-statusline.mjs',
    'skills/status/SKILL.md', 'skills/inbox/SKILL.md', 'skills/mark-read/SKILL.md']) await copy(`plugins/claude-code/${file}`);
  for (const file of ['packages/setup/dist/src/cli.js', 'packages/setup/dist/src/index.js', 'packages/setup/dist/src/index.d.ts']) {
    if (!inventory[file]) throw new Error(`Build first: missing ${file}`);
  }
  // Ship the SCM helper as bytes; installing the CLI never runs Go or an
  // elevation prompt. Native execution is verified separately on Windows.
  const helper = path.join(output, 'bin/murmur-svc.exe');
  await fs.mkdir(path.dirname(helper), { recursive: true });
  execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags',
    `-s -w -X=main.releaseVersion=${root.version} -X=main.releaseCommit=${sourceCommit ?? 'unknown'}`,
    '-o', helper, '.'], { cwd: path.join(source, 'spikes/windows-service-go'),
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOFLAGS: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const helperBytes = await fs.readFile(helper);
  if (helperBytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Windows helper is not a PE executable');
  inventory['bin/murmur-svc.exe'] = { sha256: hash(helperBytes), size: helperBytes.length };
  const manifest = { schema: 'murmur.npm-cli/1', sourceCommit, sourceDirty, declaredVersion: root.version,
    sourceLockSha256: hash(await fs.readFile(path.join(source, 'package-lock.json'))),
    windowsHelper: { component: 'windows-service', platform: 'windows', arch: 'amd64', version: root.version, sourceCommit,
      sha256: hash(helperBytes), size: helperBytes.length, nativeVersionExecuted: false }, files: inventory };
  await fs.writeFile(path.join(output, 'npm-runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function main() {
  const source = path.resolve(path.dirname(HERE), '..');
  const setup = path.join(source, 'packages/setup');
  const staging = await fs.mkdtemp(path.join(setup, '.npm-runtime-'));
  try {
    const output = path.join(staging, 'runtime');
    const manifest = await stageCliRuntime(source, output);
    // Only this generated directory is replaced; the selected user profile is
    // never an input or a target of the packaging command.
    await fs.rm(path.join(setup, 'runtime'), { recursive: true, force: true });
    await fs.rename(output, path.join(setup, 'runtime'));
    await fs.copyFile(path.join(source, 'LICENSE'), path.join(setup, 'LICENSE'));
    // Lifecycle stdout would corrupt `npm pack --json` for callers.
    console.error(JSON.stringify({ schema: manifest.schema, version: manifest.declaredVersion, files: Object.keys(manifest.files).length }));
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === HERE) main().catch(e => { console.error(e.message); process.exitCode = 1; });
