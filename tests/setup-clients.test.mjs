import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as TOML from '@iarna/toml';
import { configureClient, previewClientConfiguration, sameClientFileIdentity } from '../packages/setup/dist/src/clients.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { createKeyPair, createSigningKeyPair } from '../packages/security/dist/src/index.js';
import { main } from '../packages/setup/dist/src/cli.js';

test('Windows missing volume serial preserves full inode and known-device refusal', () => {
  const pathInfo = { dev: 0n, ino: 844424931489285n };
  const handleInfo = { dev: 3606225537n, ino: pathInfo.ino };
  assert.equal(sameClientFileIdentity(pathInfo, handleInfo, 'win32'), true);
  assert.equal(sameClientFileIdentity(pathInfo, { ...handleInfo, ino: pathInfo.ino + 1n }, 'win32'), false);
  assert.equal(sameClientFileIdentity(handleInfo, { ...handleInfo, dev: handleInfo.dev + 1n }, 'win32'), false);
  assert.equal(sameClientFileIdentity(pathInfo, handleInfo, 'linux'), false);
  assert.equal(sameClientFileIdentity(pathInfo, handleInfo, 'darwin'), false);
  assert.equal(sameClientFileIdentity({ ...handleInfo, dev: (1n << 32n) + handleInfo.dev }, handleInfo, 'win32'), true);
  const large = { dev: 0n, ino: 2n ** 60n };
  assert.equal(sameClientFileIdentity(large, { ...large, ino: large.ino + 1n }, 'win32'), false);
});
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
  const result = await configureClient(f.context, f.adapter, 'codex-cli').catch(async error => {
    // Report only synthetic fixture metadata when a native filesystem differs.
    const describe = s => ({ regular: s.isFile(), link: s.isSymbolicLink(), dev: String(s.dev), ino: String(s.ino), uid: String(s.uid), size: String(s.size) });
    const before = await fs.lstat(f.file, { bigint: true }), handle = await fs.open(f.file, 'r');
    try {
      t.diagnostic(JSON.stringify({ node: process.version, uv: process.versions.uv,
        before: describe(before), opened: describe(await handle.stat({ bigint: true })),
        after: describe(await fs.lstat(f.file, { bigint: true })) }));
    } finally { await handle.close(); }
    throw error;
  });
  assert.equal(await fs.readFile(result.backup, 'utf8'), source);
  if (process.platform !== 'win32') assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
  const output = await fs.readFile(f.file, 'utf8'), parsed = format === 'json' ? JSON.parse(output) : TOML.parse(output);
  assert.equal(parsed[key].murmur.env.DATA_DIR, f.context.dataDir);
  delete parsed[key].murmur; assert.deepEqual(parsed, input);
  assert.equal((await configureClient(f.context, f.adapter, 'codex-cli')).changed, false);
});

async function profile(f) {
  const config = { agentId: 'client-test', subject: 'msg.client-test', natsUrl: 'nats://127.0.0.1:4222',
    keys: { encryption: await createKeyPair(), signing: await createSigningKeyPair() }, peers: {} };
  await fs.mkdir(f.context.dataDir, { recursive: true });
  await fs.writeFile(f.context.configPath, JSON.stringify(config), { mode: 0o600 });
  return config;
}
test('client preview is read-only, binds identity and emits no existing secrets', async t => {
  const f = await fixture(t, 'json'); await profile(f);
  const nested = path.join(f.root, 'missing', 'settings.json');
  f.adapter.detectClients = async () => [{ id: 'codex-cli', installed: true, configPath: nested, format: 'json' }];
  const plan = await previewClientConfiguration(f.context, f.adapter, 'codex-cli');
  assert.equal(plan.action, 'add'); assert.equal(plan.agentId, 'client-test');
  await assert.rejects(fs.stat(path.dirname(nested)), { code: 'ENOENT' });
  await fs.mkdir(path.dirname(nested));
  const original = JSON.stringify({ token: 'fixture-secret-never-return', mcpServers: { murmur: { command: '/old' } } });
  await fs.writeFile(nested, original);
  const conflict = await previewClientConfiguration(f.context, f.adapter, 'codex-cli');
  assert.equal(conflict.action, 'replace'); assert.ok(!JSON.stringify(conflict).includes('fixture-secret'));
  assert.equal(await fs.readFile(nested, 'utf8'), original);
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli', false, conflict.planId), /murmur-entry-conflict/);
  assert.equal(await fs.readFile(nested, 'utf8'), original);
  const result = await configureClient(f.context, f.adapter, 'codex-cli', true, conflict.planId);
  assert.equal(result.planId, conflict.planId); assert.equal(result.agentId, plan.agentId);
  assert.equal(await fs.readFile(result.backup, 'utf8'), original);
});
for (const change of ['file', 'identity', 'target', 'runtime']) test(`confirmed plan refuses changed ${change}`, async t => {
  const f = await fixture(t, 'toml'), config = await profile(f);
  await fs.writeFile(f.file, 'model = "keep"\n');
  const plan = await previewClientConfiguration(f.context, f.adapter, 'codex-cli');
  let context = f.context, target = f.file;
  if (change === 'file') await fs.writeFile(f.file, 'model = "changed-by-client"\n');
  if (change === 'identity') {
    config.agentId = 'other-agent'; config.subject = 'msg.other-agent';
    await fs.writeFile(f.context.configPath, JSON.stringify(config));
  }
  if (change === 'target') {
    target = path.join(f.root, 'other.toml'); await fs.writeFile(target, 'model = "other-target"\n');
    f.adapter.detectClients = async () => [{ id: 'codex-cli', installed: true, configPath: target, format: 'toml' }];
  }
  if (change === 'runtime') context = { ...context, nodePath: path.join(f.root, 'other-node') };
  const before = await fs.readFile(target);
  await assert.rejects(configureClient(context, f.adapter, 'codex-cli', true, plan.planId), /plan-stale/);
  assert.deepEqual(await fs.readFile(target), before);
  assert.deepEqual((await fs.readdir(f.root)).filter(p => /backup|murmur-lock|\.tmp$/.test(p)), []);
});
test('CLI preview/apply route supports unchanged entry without rewriting bytes', async t => {
  const f = await fixture(t, 'toml'); await profile(f);
  const argv = ['--data-dir', f.context.dataDir, '--client', 'codex-cli'];
  const plan = await main(['clients', 'preview', ...argv], f.adapter);
  const applied = await main(['clients', 'configure', ...argv, '--plan-id', plan.planId], f.adapter);
  assert.equal(applied.changed, true);
  const next = await main(['clients', 'preview', ...argv], f.adapter), before = await fs.readFile(f.file);
  assert.equal(next.action, 'unchanged');
  assert.equal((await main(['clients', 'configure', ...argv, '--plan-id', next.planId], f.adapter)).changed, false);
  assert.deepEqual(await fs.readFile(f.file), before);
});
test('existing other Murmur contour requires explicit replacement and retains backup', async t => {
  const f = await fixture(t, 'json'); const before = JSON.stringify({ mcpServers: { murmur: { command: '/foreign' } } });
  await fs.writeFile(f.file, before);
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli'), /murmur-entry-conflict/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  const changed = await configureClient(f.context, f.adapter, 'codex-cli', true);
  assert.equal(await fs.readFile(changed.backup, 'utf8'), before);
});
test('malformed config is rejected without rewriting it', async t => {
  const f = await fixture(t, 'json'); await fs.writeFile(f.file, 'not json');
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli'), /config-parse-failed/);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'not json');
});
for (const dangling of [false, true]) test(`client preview/apply reject ${dangling ? 'dangling' : 'existing'} symlink without replacing it`, async t => {
  const f = await fixture(t, 'json'); await profile(f);
  const target = path.join(f.root, 'unrelated');
  if (!dangling) await fs.writeFile(target, '{}');
  await fs.symlink(target, f.file, 'file');
  for (const run of [previewClientConfiguration, configureClient]) {
    await assert.rejects(run(f.context, f.adapter, 'codex-cli'), /config-file-invalid/);
    assert.equal(await fs.readlink(f.file), target);
    if (dangling) await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(target, 'utf8'), '{}');
    assert.deepEqual((await fs.readdir(f.root)).filter(p => /backup|murmur-lock|\.tmp$/.test(p)), []);
  }
});
test('unknown profile path is not guessed or written', async t => {
  const f = await fixture(t, 'json'); f.adapter.detectClients = async () => [{ id: 'codex-cli', installed: true, configPath: null, format: 'json' }];
  await assert.rejects(configureClient(f.context, f.adapter, 'codex-cli'), /path-unverified/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});
