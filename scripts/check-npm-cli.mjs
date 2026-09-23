#!/usr/bin/env node
// Acceptance probe deliberately imports only Node built-ins, never checkout deps.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const packageRoot = await fs.realpath(process.argv[2]);
const runtime = path.join(packageRoot, 'runtime');
const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'npm-runtime-manifest.json')));
assert.equal(manifest.schema, 'murmur.npm-cli/1');
const inventory = new Set(Object.keys(manifest.files));
async function verify(dir, prefix = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false, `Unexpected symlink: ${name}`);
    if (entry.isDirectory()) { await verify(path.join(dir, entry.name), name); continue; }
    assert.ok(entry.isFile(), `Unexpected file type: ${name}`);
    if (name === 'npm-runtime-manifest.json') continue;
    assert.ok(inventory.delete(name), `Unmanifested file: ${name}`);
    const bytes = await fs.readFile(path.join(dir, entry.name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[name].sha256, name);
    assert.equal(bytes.length, manifest.files[name].size, name);
  }
}
await verify(runtime); assert.equal(inventory.size, 0, 'Missing manifest files');
const helper = manifest.windowsHelper;
assert.equal(helper.version, manifest.declaredVersion);
assert.equal(helper.sha256, manifest.files['bin/murmur-svc.exe'].sha256);
let nativeVersionExecuted = false;
if (process.platform === 'win32') {
  const native = JSON.parse(execFileSync(path.join(runtime, 'bin/murmur-svc.exe'), ['--version'], { encoding: 'utf8' }));
  assert.equal(native.schema, 'murmur.native-version/1');
  assert.equal(native.component, 'windows-service');
  assert.equal(native.platform, 'windows');
  assert.equal(native.arch, 'amd64');
  assert.equal(native.version, manifest.declaredVersion);
  assert.equal(native.sourceCommit, manifest.sourceCommit ?? 'unknown');
  nativeVersionExecuted = true;
}
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur npm probe '));
let child;
try {
  const profile = path.join(temp, 'profile');
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DATA_DIR: profile,
    MURMUR_DATA_DIR: profile, MURMUR_STORE_PATH: '', MURMUR_UPDATE_CHECK: '0' };
  const cli = args => JSON.parse(execFileSync(process.execPath, [path.join(packageRoot, 'bin/murmur-npm.mjs'), ...args],
    { cwd: temp, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }));
  assert.equal(cli(['version']).version, manifest.declaredVersion);
  assert.equal(cli(['init', '--data-dir', profile, '--agent-id', 'runtime-probe', '--broker-url', 'nats://127.0.0.1:4222']).agentId, 'runtime-probe');
  assert.equal(cli(['status', '--data-dir', profile]).agentId, 'runtime-probe');
  child = spawn(process.execPath, [path.join(runtime, 'packages/mcp-server/dist/src/index.js')], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  const replies = new Map();
  reader.on('line', line => { try { const message = JSON.parse(line); const pending = replies.get(message.id); if (pending) { replies.delete(message.id); pending.resolve(message); } } catch {} });
  child.on('error', error => { for (const p of replies.values()) p.reject(error); });
  child.on('exit', code => { for (const p of replies.values()) p.reject(new Error(`MCP exited before reply: ${code}`)); });
  async function request(id, method, params) {
    let timer;
    try {
      const response = await new Promise((resolve, reject) => {
        replies.set(id, { resolve, reject }); timer = setTimeout(() => reject(new Error(`MCP timed out: ${method}`)), 10000);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      assert.equal(response.error, undefined); return response.result;
    } finally { clearTimeout(timer); replies.delete(id); }
  }
  assert.ok((await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'runtime-probe', version: '1' } })).serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request(2, 'tools/list', {});
  assert.ok(listed.tools.some(tool => tool.name === 'murmur_request'));
  await request(3, 'tools/call', { name: 'murmur_peers', arguments: {} });
  reader.close();
  console.log(JSON.stringify({ ok: true, sourceCommit: manifest.sourceCommit, version: manifest.declaredVersion,
    files: Object.keys(manifest.files).length, nativeVersionExecuted, cli: ['version', 'init', 'status'], mcp: ['initialize', 'tools/list', 'murmur_peers'], roundtrip: 'not-tested' }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
  }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
