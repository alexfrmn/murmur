import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { configureClient, previewClientConfiguration } from '../packages/setup/dist/src/clients.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { main } from '../packages/setup/dist/src/cli.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const slash = value => value.replaceAll('\\', '/');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-claude-hook- пробел кириллица-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), configPath = path.join(home, '.claude.json');
  const settingsPath = path.join(home, '.claude', 'settings.json');
  await fs.mkdir(home);
  const context = resolveContext({ dataDir: path.join(root, 'profile'), repoRoot });
  const adapter = { detectClients: async () => [{ id: 'claude-code', installed: true, configPath, format: 'json' }] };
  const settings = async () => JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  const ourHooks = async () => (await settings()).hooks.Stop.flatMap(group => group.hooks).filter(hook => hook.command.includes('wake-drain-claude'));
  return { root, home, configPath, settingsPath, context, adapter, settings, ourHooks };
}

test('claude-code gets the MCP entry and the Stop wake hook for this profile', async t => {
  const f = await fixture(t);
  const result = await configureClient(f.context, f.adapter, 'claude-code');
  assert.equal(result.changed, true);
  assert.equal(result.wakeHook.action, 'add'); assert.equal(result.wakeHook.backup, null);
  assert.ok(JSON.parse(await fs.readFile(f.configPath, 'utf8')).mcpServers.murmur);
  const [hook] = await f.ourHooks();
  assert.equal(hook.type, 'command'); assert.equal(hook.asyncRewake, true);
  assert.equal(hook.timeout, 28800, 'the entry must carry its own timeout: Claude Code ends asyncRewake hooks after 600 s otherwise (#273)');
  assert.equal(hook.command, `"${slash(f.context.nodePath)}" --no-warnings "${slash(path.join(repoRoot, 'scripts', 'wake-drain-claude.mjs'))}" --db "${slash(f.context.storePath)}" --max-seconds 28800`);
  assert.doesNotMatch(hook.command, /\.sh"/);
  // Idempotent: a second run changes nothing and never duplicates the hook.
  const again = await configureClient(f.context, f.adapter, 'claude-code');
  assert.equal(again.changed, false); assert.equal(again.wakeHook.action, 'unchanged');
  assert.equal((await f.ourHooks()).length, 1);
});

test('other settings and hooks are kept, with a private backup of the original', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.settingsPath));
  const original = { model: 'user-choice', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } };
  const originalText = JSON.stringify(original, null, 2);
  await fs.writeFile(f.settingsPath, originalText);
  const result = await configureClient(f.context, f.adapter, 'claude-code');
  assert.equal(await fs.readFile(result.wakeHook.backup, 'utf8'), originalText);
  const next = await f.settings();
  assert.equal(next.model, 'user-choice');
  assert.deepEqual(next.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(next.hooks.Stop[0], original.hooks.Stop[0]);
  assert.equal((await f.ourHooks()).length, 1);
});

test('a different Murmur wake hook is replaced only on request, and the .sh variant goes', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.settingsPath));
  const shell = { type: 'command', command: '/opt/murmur/scripts/wake-drain-claude.sh', asyncRewake: true };
  const other = { type: 'command', command: 'notify-done' };
  const before = JSON.stringify({ hooks: { Stop: [{ hooks: [shell, other] }] } });
  await fs.writeFile(f.settingsPath, before);
  await assert.rejects(configureClient(f.context, f.adapter, 'claude-code'), /client\.wake-hook-conflict/);
  assert.equal(await fs.readFile(f.settingsPath, 'utf8'), before);
  await assert.rejects(fs.stat(f.configPath), { code: 'ENOENT' }); // refused before the MCP entry was written
  const replaced = await configureClient(f.context, f.adapter, 'claude-code', true);
  assert.equal(replaced.wakeHook.action, 'replace');
  const hooks = (await f.settings()).hooks.Stop.flatMap(group => group.hooks);
  assert.deepEqual(hooks.filter(hook => !hook.command.includes('wake-drain-claude')), [other]);
  assert.equal((await f.ourHooks()).length, 1);
  assert.doesNotMatch((await f.ourHooks())[0].command, /\.sh/);
});

test('an entry written by 2.11.0 (no timeout) makes the whole plan a replace, so apps ask once and upgrade it', async t => {
  const f = await fixture(t);
  await main(['init', '--agent-id', 'hook-upgrade', '--broker-url', 'nats://127.0.0.1:4222', '--data-dir', f.context.dataDir], { manager: 'none' });
  // First configure with the current engine, then strip the timeout the way 2.11.0 wrote it.
  await configureClient(f.context, f.adapter, 'claude-code');
  const current = await f.settings();
  for (const group of current.hooks.Stop) for (const hook of group.hooks) if (hook.command.includes('wake-drain-claude')) delete hook.timeout;
  await fs.writeFile(f.settingsPath, JSON.stringify(current));
  const plan = await previewClientConfiguration(f.context, f.adapter, 'claude-code');
  assert.equal(plan.wakeHook.action, 'replace');
  assert.equal(plan.action, 'replace', 'the MCP entry is unchanged, but the plan must still say replace for the Mac app to pass --replace');
  await assert.rejects(configureClient(f.context, f.adapter, 'claude-code'), /client\.wake-hook-conflict/);
  const upgraded = await configureClient(f.context, f.adapter, 'claude-code', true);
  assert.equal(upgraded.changed, true); assert.equal(upgraded.wakeHook.action, 'replace');
  const [hook] = await f.ourHooks();
  assert.equal(hook.timeout, 28800);
  const settled = await previewClientConfiguration(f.context, f.adapter, 'claude-code');
  assert.equal(settled.action, 'unchanged'); assert.equal(settled.wakeHook.action, 'unchanged');
});

test('the confirmation plan covers the hook and goes stale when settings change', async t => {
  const f = await fixture(t);
  await main(['init', '--agent-id', 'hook-test', '--broker-url', 'nats://127.0.0.1:4222', '--data-dir', f.context.dataDir], { manager: 'none' });
  const plan = await previewClientConfiguration(f.context, f.adapter, 'claude-code');
  assert.deepEqual(plan.wakeHook, { settingsPath: f.settingsPath, action: 'add' });
  await assert.rejects(fs.stat(path.dirname(f.settingsPath)), { code: 'ENOENT' }); // preview writes nothing
  await fs.mkdir(path.dirname(f.settingsPath));
  await fs.writeFile(f.settingsPath, '{"model":"changed-after-preview"}');
  await assert.rejects(configureClient(f.context, f.adapter, 'claude-code', false, plan.planId), /client\.plan-stale/);
  const fresh = await previewClientConfiguration(f.context, f.adapter, 'claude-code');
  const done = await configureClient(f.context, f.adapter, 'claude-code', false, fresh.planId);
  assert.equal(done.planId, fresh.planId); assert.equal(done.wakeHook.action, 'add');
});

test('the wake drain reads the store given by --db, as the hook passes it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-drain-db- пробел-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = path.join(root, 'profile', 'murmur.db');
  await fs.mkdir(path.dirname(db));
  const store = new DatabaseSync(db);
  store.exec('CREATE TABLE local_messages (msg_id TEXT PRIMARY KEY, created_at TEXT, sender TEXT, conversation_id TEXT, direction TEXT, text TEXT)');
  const env = { ...process.env, HOME: root, USERPROFILE: root, MURMUR_DB: path.join(root, 'wrong.db'), MURMUR_WAKE_SESSION_KEY: 'hooktest' };
  const drain = () => spawnSync(process.execPath, ['--no-warnings', path.join(repoRoot, 'scripts', 'wake-drain-claude.mjs'), '--once', '--db', db], { env, encoding: 'utf8' });
  assert.equal(drain().status, 0, 'first run seeds the cursor at the empty tip');
  store.prepare("INSERT INTO local_messages VALUES ('m1','2026-09-24T00:00:00.000Z','agent-peer','conv','inbound','wake up')").run();
  store.close();
  const woke = drain();
  assert.equal(woke.status, 2, woke.stdout + woke.stderr);
  assert.match(woke.stdout + woke.stderr, /agent-peer/);
});

test('--max-seconds bounds the drain poll and wins over MURMUR_WAKE_MAX_SECONDS', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-drain-window-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = path.join(root, 'murmur.db');
  const store = new DatabaseSync(db);
  store.exec('CREATE TABLE local_messages (msg_id TEXT PRIMARY KEY, created_at TEXT, sender TEXT, conversation_id TEXT, direction TEXT, text TEXT)');
  store.close();
  const env = { ...process.env, HOME: root, USERPROFILE: root, MURMUR_WAKE_SESSION_KEY: 'window', MURMUR_WAKE_MAX_SECONDS: '3600', MURMUR_WAKE_POLL_MS: '200' };
  const drain = extra => spawnSync(process.execPath, ['--no-warnings', path.join(repoRoot, 'scripts', 'wake-drain-claude.mjs'), '--db', db, ...extra], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(drain(['--once']).status, 0); // seed the cursor
  const started = Date.now();
  const polled = drain(['--max-seconds', '2']);
  assert.equal(polled.error, undefined, 'the environment hour must not apply');
  assert.equal(polled.status, 0, polled.stdout + polled.stderr);
  assert.ok(Date.now() - started < 15_000, `poll lasted ${Date.now() - started} ms`);
});

test('no hook is installed when this runtime does not ship the wake drain', async t => {
  const f = await fixture(t);
  const bare = path.join(f.root, 'runtime-without-drain');
  await fs.mkdir(path.join(bare, 'scripts'), { recursive: true });
  const context = resolveContext({ dataDir: f.context.dataDir, repoRoot: bare });
  await assert.rejects(configureClient(context, f.adapter, 'claude-code'), /^Error: client\.wake-drain-missing$/);
  await assert.rejects(fs.stat(f.configPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.settingsPath), { code: 'ENOENT' });
});

test('the released runtime and npm package carry the script the installed hook runs', async () => {
  const { SCRIPTS } = await import('../scripts/build-runtime-bundle.mjs');
  assert.ok(SCRIPTS.includes('wake-drain-claude.mjs'));
  for (const script of SCRIPTS) assert.ok((await fs.stat(path.join(repoRoot, 'scripts', script))).isFile(), script);
});
