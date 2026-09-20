import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SQLiteMessageStore, SQLiteDedupeOutboxStore } from '../packages/core/dist/src/index.js';
import { main, isRawCliOutput } from '../packages/setup/dist/src/cli.js';
import { renderStatusLine } from '../packages/setup/dist/src/status-line.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const now = Date.parse('2026-09-20T12:00:00Z');
const baseStatus = (unread = 0) => ({
  schema: 'murmur.status/1', generatedAt: new Date(now).toISOString(),
  service: { state: 'running', restartsLastHour: 0 },
  broker: { state: 'connected' }, peers: { list: [{ agentId: 'peer', paired: true }] },
  inbox: { unread, total: unread },
  outbox: { queue: { pending: 0, inflight: 0, delivered: 0, failed: 0, dlq: 0, unknownReason: null },
    faults: { unknownReason: null } },
  wake: { config: { enabled: true, unknownReason: null }, effective: { enabled: true, unknownReason: null },
    delivery: { pendingUndelivered: 0, unknownReason: null }, faults: { lastFault: null, unknownReason: null } },
});
const stopped = { manager: 'none', status: async () => ({ state: 'stopped', manager: 'none', pid: null, since: null,
  lastExitCode: null, observedStorePath: null, restartCount: null, restartWindowMs: null }) };
const temporary = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-terminal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
async function profile(t) {
  const dataDir = await temporary(t), context = resolveContext({ dataDir, repoRoot: root });
  const key = Buffer.alloc(32, 3).toString('base64');
  await fs.writeFile(context.configPath, JSON.stringify({ agentId: 'agent-a', subject: 'msg.agent-a', natsUrl: 'nats://127.0.0.1:4222',
    keys: { signing: { publicKey: key, privateKey: key }, encryption: { publicKey: key, privateKey: key } }, peers: {} }));
  const messages = new SQLiteMessageStore(context.storePath); new SQLiteDedupeOutboxStore(context.storePath).close();
  return { dataDir, context, messages };
}

test('status line is empty only for measured clean state and shows unread or uncertainty', () => {
  assert.equal(renderStatusLine(baseStatus(), now), '');
  assert.equal(renderStatusLine(baseStatus(4), now), 'Murmur: 4 unread');
  const failed = baseStatus(2); failed.outbox.queue.failed = 1;
  assert.equal(renderStatusLine(failed, now), 'Murmur: 2 unread | Murmur: error (outbox.undelivered)');
  assert.equal(renderStatusLine({ malicious: '\u001b]52;c;payload\u0007' }, now), 'Murmur: unknown (schema.missing-key)');
  assert.doesNotMatch(renderStatusLine({ malicious: '\u001b[31m' }, now), /[\x00-\x1f\x7f]/);
});

test('status --line returns a raw composable result and rejects conflicting output modes', async t => {
  const f = await profile(t);
  const result = await main(['status', '--line', '--data-dir', f.dataDir], stopped);
  assert.equal(isRawCliOutput(result), true);
  assert.match(result.text, /^Murmur: unknown \(/);
  const raw = execFileSync(process.execPath, ['packages/setup/bin/murmur.mjs', 'status', '--line', '--data-dir', f.dataDir],
    { cwd: root, encoding: 'utf8', env: { ...process.env, MURMUR_UPDATE_CHECK: '0' } });
  assert.match(raw, /^Murmur: unknown \(/); assert.doesNotMatch(raw, /^[{"']/);
  const failed = spawnSync(process.execPath, ['packages/setup/bin/murmur.mjs', 'status', '--line', '--data-dir', 'relative'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, MURMUR_UPDATE_CHECK: '0' } });
  assert.notEqual(failed.status, 0); assert.equal(failed.stdout, 'Murmur: unknown (status.command-failed)\n');
  await assert.rejects(main(['status', '--line', '--json', '--data-dir', f.dataDir], stopped), /output-mode-conflict/);
  await assert.rejects(main(['mcp', 'serve'], stopped), /required-option:data-dir/);
  f.messages.close();
});

test('inbox read returns durable messages without marking them and mark-read stays explicit', async t => {
  const f = await profile(t);
  await fs.writeFile(path.join(f.dataDir, 'read-state.json'), JSON.stringify({ schema: 'murmur.read/1', agentId: 'agent-a', rowid: 0 }));
  await f.messages.append({ conversationId: 'peer:task', msgId: 'm1', direction: 'inbound', sender: 'peer',
    text: 'review me', createdAt: '2026-09-20T11:00:00Z' });
  const cursorPath = path.join(f.dataDir, 'read-state.json'), before = await fs.readFile(cursorPath);
  const result = await main(['inbox', 'read', '--limit', '20', '--data-dir', f.dataDir], stopped);
  assert.equal(result.schema, 'murmur.inbox/1');
  assert.equal(result.unread, 1); assert.equal(result.messages[0].text, 'review me'); assert.equal(result.messages[0].unread, true);
  assert.deepEqual(await fs.readFile(cursorPath), before);
  const marked = await main(['inbox', 'mark-read', '--data-dir', f.dataDir], stopped);
  assert.equal(marked.rowid, 1);
  assert.equal((await main(['inbox', 'read', '--data-dir', f.dataDir], stopped)).unread, 0);
  await assert.rejects(main(['inbox', 'read', '--limit', '101', '--data-dir', f.dataDir], stopped), /limit-invalid/);
  f.messages.close();
});

test('explicit-profile mcp serve starts the existing server without contaminating JSON-RPC stdout', async t => {
  const f = await profile(t); f.messages.close();
  const child = spawn(process.execPath, ['packages/setup/bin/murmur.mjs', 'mcp', 'serve', '--data-dir', f.dataDir], {
    cwd: root, env: { ...process.env, MURMUR_UPDATE_CHECK: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let buffer = '';
  const replies = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mcp fixture timed out')), 5000);
    child.on('error', reject);
    child.stderr.on('data', chunk => { if (!String(chunk).includes('ExperimentalWarning')) reject(new Error(String(chunk))); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.trim().split('\n').filter(Boolean);
      if (lines.length >= 2) { clearTimeout(timer); resolve(lines.map(JSON.parse)); }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  const messages = await replies;
  assert.equal(messages[0].result.serverInfo.name, 'murmur-v2-mcp');
  assert.ok(messages[1].result.tools.some(tool => tool.name === 'murmur_inbox'));
  child.kill();
});

test('Claude statusline dry run preserves the existing command, writes nothing and strips Murmur escapes', async t => {
  if (process.platform === 'win32') { t.skip('POSIX shell fixture'); return; }
  const dir = await temporary(t), settings = path.join(dir, 'settings.json'), fake = path.join(dir, 'fake murmur');
  const original = JSON.stringify({ statusLine: { type: 'command', command: "printf 'legacy'", padding: 2 }, unrelated: { keep: true } }, null, 2);
  await fs.writeFile(settings, original);
  await fs.writeFile(fake, "#!/bin/sh\nprintf '\\033]52;c;payload\\007Murmur: 3 unread\\n'\n", { mode: 0o700 });
  const configure = path.join(root, 'plugins/claude-code/scripts/configure-statusline.mjs');
  const proposal = JSON.parse(execFileSync(process.execPath, [configure, '--dry-run', '--settings', settings,
    '--data-dir', dir, '--murmur-bin', fake], { encoding: 'utf8' }));
  assert.equal(proposal.writesPerformed, false); assert.equal(proposal.preservedExistingCommand, true);
  assert.equal(proposal.proposedStatusLine.padding, 2); assert.equal(proposal.proposedStatusLine.refreshInterval, 5);
  assert.equal(await fs.readFile(settings, 'utf8'), original);
  const rendered = execFileSync('/bin/sh', ['-lc', proposal.proposedStatusLine.command], { input: '{}', encoding: 'utf8' });
  assert.match(rendered, /^legacy\n/); assert.match(rendered, /Murmur: 3 unread/); assert.doesNotMatch(rendered, /\x1b|\x07/);
});

test('Claude plugin manifest uses supported components and an explicit-profile MCP command', async () => {
  const plugin = path.join(root, 'plugins/claude-code');
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  const mcp = JSON.parse(await fs.readFile(path.join(plugin, '.mcp.json'), 'utf8'));
  assert.equal(manifest.name, 'murmur'); assert.equal(manifest.defaultEnabled, false);
  assert.equal(Object.hasOwn(manifest, 'statusLine'), false);
  assert.equal(manifest.userConfig.data_dir.required, true);
  assert.deepEqual(mcp.mcpServers.murmur.args, ['mcp', 'serve', '--data-dir', '${user_config.data_dir}']);
});
