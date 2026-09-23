import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as TOML from '@iarna/toml';
import { configureClient } from '../packages/setup/dist/src/clients.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { assertMode, skipWithoutSymlinks } from './windows-host.mjs';
async function fixture(t, format) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-mcp-config-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, `config.${format}`), context = resolveContext({ dataDir: path.join(root, 'data'), repoRoot: fileURLToPath(new URL('../', import.meta.url)) });
  const adapter = { detectClients: async () => [{ id: 'codex-cli', installed: true, configPath: file, format }] };
  return { root, file, context, adapter };
}
for (const format of ['json', 'toml']) test(`${format}: patch keeps auth rails, unrelated settings and other MCP servers, with exact backup`, async t => {
  const f = await fixture(t, format), key = format === 'json' ? 'mcpServers' : 'mcp_servers';
  const input = { forced_login_method: 'chatgpt', enable_codex_api_key_env: false, model: 'user-choice', [key]: { existing: { command: '/some/tool', args: ['do-not-change'] } }, custom: { nested: 'preserve' } };
  const source = format === 'json' ? JSON.stringify(input) : '# preserved in backup\n' + TOML.stringify(input);
  await fs.writeFile(f.file, source);
  const result = await configureClient(f.context, f.adapter, 'codex-cli');
  assert.equal(await fs.readFile(result.backup, 'utf8'), source);
  assertMode(t, (await fs.stat(result.backup)).mode, 0o600, 'backup mode');
  const output = await fs.readFile(f.file, 'utf8'), parsed = format === 'json' ? JSON.parse(output) : TOML.parse(output);
  assert.equal(parsed[key].murmur.env.DATA_DIR, f.context.dataDir);
  delete parsed[key].murmur; assert.deepEqual(parsed, input);
  assert.equal((await configureClient(f.context, f.adapter, 'codex-cli')).changed, false);
});
test('existing other Murmur contour requires explicit replacement and retains backup', async t => {
  const f = await fixture(t, 'json'); const before = JSON.stringify({ mcpServers: { murmur: { command: '/foreign' } } });
  await fs.writeFile(f.file, before);
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli'), /murmur-entry-conflict/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  const changed = await configureClient(f.context, f.adapter, 'codex-cli', true);
  assert.equal(await fs.readFile(changed.backup, 'utf8'), before);
});
test('malformed config and symlink are rejected without rewriting their target', { skip: skipWithoutSymlinks }, async t => {
  const f = await fixture(t, 'json'); await fs.writeFile(f.file, 'not json');
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli'), /config-parse-failed/);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'not json');
  const target = path.join(f.root, 'unrelated'); await fs.writeFile(target, '{}'); await fs.unlink(f.file); await fs.symlink(target, f.file);
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli'));
  assert.equal(await fs.readFile(target, 'utf8'), '{}');
});
test('unknown profile path is not guessed or written', async t => {
  const f = await fixture(t, 'json'); f.adapter.detectClients = async () => [{ id: 'codex-cli', installed: true, configPath: null, format: 'json' }];
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli'), /path-unverified/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});
