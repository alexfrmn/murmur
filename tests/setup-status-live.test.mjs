import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { initialize } from '../packages/setup/dist/src/onboarding.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { platformAdapter } from '../packages/setup/dist/src/cli.js';
import { readStatus } from '../packages/setup/dist/src/status.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real unmanaged daemon reports its first Server failure and its live store without a service install',
  { timeout: 20000, skip: !['darwin', 'linux'].includes(process.platform) && 'native descriptor probe runs on macOS/Linux' }, async t => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-status-live-'));
    const context = resolveContext({ dataDir, repoRoot: root });
    let child, log = '';
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    await initialize(context, { agentId: 'status-live', brokerUrl: `nats://127.0.0.1:${port}` });
    const before = await fs.readFile(context.configPath);
    child = spawn(process.execPath, ['scripts/murmur-daemon.mjs'], {
      cwd: root, env: { PATH: process.env.PATH, HOME: dataDir, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    let snapshot;
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      snapshot = await readStatus({ context, adapter: platformAdapter() });
      if (snapshot.broker.lastError === 'broker.connection-refused') break;
      assert.equal(child.exitCode, null, 'isolated daemon keeps retrying initial connection');
      await delay(100);
    }
    assert.equal(snapshot.service.state, 'running-unmanaged');
    assert.equal(snapshot.service.pid, child.pid);
    assert.equal(snapshot.service.observedStorePath, await fs.realpath(context.storePath));
    assert.equal(snapshot.broker.state, 'disconnected');
    assert.equal(snapshot.broker.lastError, 'broker.connection-refused');
    assert.match(log, /"reason":"broker.connection-refused"/);
    assert.deepEqual(await fs.readFile(context.configPath), before);
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
    assert.notEqual((await readStatus({ context, adapter: platformAdapter() })).service.state, 'running-unmanaged',
      'even a fresh observation cannot keep a terminated process alive');
  });
