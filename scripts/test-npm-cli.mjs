#!/usr/bin/env node
// Tarball installation after npm ci: this must work without importing
// anything from the checkout and without running install/build lifecycle hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runNpm } from './npm-command.mjs';
import { validatePack } from './publish-all.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur npm проба '));
try {
  const tarballs = [], packed = [];
  for (const workspace of ['security', 'core', 'broker-nats', 'mcp-server', 'setup']) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'packages', workspace, 'package.json'), 'utf8'));
    const info = JSON.parse(runNpm(['pack', '--workspace', pkg.name, '--pack-destination', temp, '--json'], { cwd: root }))[0];
    validatePack(pkg, info);
    tarballs.push(path.join(temp, info.filename));
    packed.push({ name: info.name, version: info.version, integrity: info.integrity, files: info.files.length });
  }
  const consumer = path.join(temp, 'consumer');
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
  // An empty cache and fresh metadata reproduce a new user's installation.
  // All Murmur inputs are local; only third-party packages use the registry.
  runNpm(['install', '--prefix', consumer, '--cache', path.join(temp, 'cache'), '--prefer-online',
    '--registry', process.env.MURMUR_TEST_REGISTRY ?? 'https://registry.npmjs.org',
    '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], { cwd: temp });
  const cli = path.join(consumer, 'node_modules/@murmurv2/cli');
  const require = createRequire(path.join(cli, 'package.json'));
  for (const name of ['core', 'security', 'broker-nats', 'mcp-server']) {
    const resolved = await fs.realpath(require.resolve(`@murmurv2/${name}`));
    assert.ok(resolved.startsWith(await fs.realpath(consumer) + path.sep), `${name} escaped the installed dependency tree`);
  }
  await fs.access(path.join(consumer, 'node_modules/.bin', process.platform === 'win32' ? 'murmur.cmd' : 'murmur'));
  const proof = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/check-npm-cli.mjs'), cli], {
    // Three bounded Windows CLI commands (60s each), MCP checks (30s total),
    // and cleanup must fit inside the parent budget instead of being killed at 45s.
    cwd: temp, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: process.platform === 'win32' ? 240_000 : 45_000,
  }));
  console.log(JSON.stringify({ ...proof, install: 'local Murmur tarballs, scripts disabled, isolated prefix', packed }));
} finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
