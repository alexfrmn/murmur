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
  const poisoned = await temporary(t);
  const poisonedStore = path.join(poisoned, 'messages.db'), poisonedRoster = path.join(poisoned, 'roster.db');
  const child = spawn(process.execPath, ['packages/setup/bin/murmur.mjs', 'mcp', 'serve', '--data-dir', f.dataDir], {
    cwd: root, env: { ...process.env, MURMUR_UPDATE_CHECK: '0', DATA_DIR: poisoned, MURMUR_DATA_DIR: poisoned,
      MURMUR_STORE_PATH: poisonedStore, MURMUR_CHANNEL_ROSTER_PATH: poisonedRoster }, stdio: ['pipe', 'pipe', 'pipe'],
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
  assert.equal(await fs.stat(path.join(f.dataDir, 'channel-roster.db')).then(() => true), true);
  assert.equal(await fs.stat(poisonedStore).then(() => true, () => false), false);
  assert.equal(await fs.stat(poisonedRoster).then(() => true, () => false), false);
});

test('Claude statusline dry run preserves the existing command, writes nothing and strips Murmur escapes', async t => {
  if (process.platform === 'win32') { t.skip('POSIX shell fixture'); return; }
  const dir = await temporary(t), settings = path.join(dir, 'settings.json'), fake = path.join(dir, 'fake-murmur.mjs');
  const original = JSON.stringify({ statusLine: { type: 'command', command: "printf 'legacy'", padding: 2 }, unrelated: { keep: true } }, null, 2);
  await fs.writeFile(settings, original);
  await fs.writeFile(fake, "process.stdout.write('\\u001b]52;c;payload\\u0007Murmur: 3 unread\\n');\n");
  const configure = path.join(root, 'plugins/claude-code/scripts/configure-statusline.mjs');
  const proposal = JSON.parse(execFileSync(process.execPath, [configure, '--dry-run', '--settings', settings,
    '--data-dir', dir, '--node-bin', process.execPath, '--murmur-entrypoint', fake], { encoding: 'utf8' }));
  assert.equal(proposal.writesPerformed, false); assert.equal(proposal.preservedExistingCommand, true);
  assert.equal(proposal.proposedStatusLine.padding, 2); assert.equal(proposal.proposedStatusLine.refreshInterval, 5);
  assert.equal(await fs.readFile(settings, 'utf8'), original);
  const rendered = execFileSync('/bin/sh', ['-lc', proposal.proposedStatusLine.command], { input: '{}', encoding: 'utf8' });
  assert.match(rendered, /^legacy\n/); assert.match(rendered, /Murmur: 3 unread/); assert.doesNotMatch(rendered, /\x1b|\x07/);
});

const statuslineArgs = (dir, entrypoint, existingCommand) => {
  const args = [path.join(root, 'plugins/claude-code/scripts/statusline.mjs'), '--data-dir', dir,
    '--murmur-node', process.execPath, '--murmur-entrypoint', entrypoint];
  if (existingCommand !== undefined) args.push('--existing-command-base64', Buffer.from(existingCommand).toString('base64'),
    '--existing-shell', 'posix');
  return args;
};

test('Claude statusline bounds a TERM-resistant existing command and its descendants', async t => {
  if (process.platform === 'win32') { t.skip('POSIX process-group fixture'); return; }
  const dir = await temporary(t), fake = path.join(dir, 'fake-murmur.mjs'), pidfile = path.join(dir, 'descendant.pid');
  await fs.writeFile(fake, "process.stdout.write('Murmur: 1 unread\\n');\n");
  const command = `trap '' TERM; sh -c 'trap "" TERM; echo $$ > "${pidfile}"; while :; do sleep 1; done' & wait`;
  const started = Date.now();
  const result = spawnSync(process.execPath, statuslineArgs(dir, fake, command), { input: '{}', encoding: 'utf8', timeout: 7_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 6_500, `elapsed ${Date.now() - started}ms`);
  assert.match(result.stdout, /^Existing status line unavailable\nMurmur: 1 unread\n$/);
  const pid = Number(await fs.readFile(pidfile, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('Claude statusline handles early stdin closure without unhandled EPIPE', async t => {
  if (process.platform === 'win32') { t.skip('POSIX shell fixture'); return; }
  const dir = await temporary(t), fake = path.join(dir, 'fake-murmur.mjs');
  await fs.writeFile(fake, "process.stdout.write('Murmur: 1 unread\\n');\n");
  const input = Buffer.alloc(1024 * 1024, 0x78);
  for (let i = 0; i < 10; i++) {
    const result = spawnSync(process.execPath, statuslineArgs(dir, fake, 'true'), { input, encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Murmur: 1 unread\n');
  }
});

test('Claude statusline input and cancellation are bounded and leave no descendant', async t => {
  if (process.platform === 'win32') { t.skip('POSIX process-group fixture'); return; }
  const dir = await temporary(t), fake = path.join(dir, 'fake-murmur.mjs'), pidfile = path.join(dir, 'cancel.pid');
  await fs.writeFile(fake, "process.stdout.write('Murmur: 1 unread\\n');\n");

  const hangingInput = spawn(process.execPath, statuslineArgs(dir, fake, "printf 'legacy'"), { stdio: ['pipe', 'pipe', 'pipe'] });
  hangingInput.stdin.write('{');
  const bounded = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    hangingInput.stdout.on('data', chunk => { stdout += chunk; });
    hangingInput.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => reject(new Error('input deadline did not fire')), 4_000);
    hangingInput.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(bounded.code, 0, bounded.stderr);
  assert.equal(bounded.stdout, 'Existing status line unavailable\nMurmur: 1 unread\n');

  const command = `trap '' TERM; sh -c 'trap "" TERM; echo $$ > "${pidfile}"; while :; do sleep 1; done' & wait`;
  const child = spawn(process.execPath, statuslineArgs(dir, fake, command), { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('{}');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !await fs.stat(pidfile).then(() => true, () => false)) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const pid = Number(await fs.readFile(pidfile, 'utf8'));
  child.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wrapper cancellation timed out')), 2_500);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.ok(exit.code === 143 || exit.signal === 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('Claude plugin manifest uses supported components and an explicit-profile MCP command', async () => {
  const plugin = path.join(root, 'plugins/claude-code');
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  const mcp = JSON.parse(await fs.readFile(path.join(plugin, '.mcp.json'), 'utf8'));
  assert.equal(manifest.name, 'murmur'); assert.equal(manifest.defaultEnabled, false);
  assert.equal(Object.hasOwn(manifest, 'statusLine'), false);
  assert.equal(manifest.userConfig.data_dir.required, true);
  assert.equal(manifest.userConfig.node_command.required, true);
  assert.equal(manifest.userConfig.murmur_entrypoint.required, true);
  assert.equal(mcp.mcpServers.murmur.command, '${user_config.node_command}');
  assert.deepEqual(mcp.mcpServers.murmur.args,
    ['${user_config.murmur_entrypoint}', 'mcp', 'serve', '--data-dir', '${user_config.data_dir}']);
});
