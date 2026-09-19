// Opt-in macOS acceptance of this adapter. Uses a unique launchd label and a
// fake daemon; no broker, user config, credentials or production service.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDarwinAdapter } from '../packages/setup/dist/src/platform/darwin.js';

assert.equal(process.platform, 'darwin');
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-launchd-smoke-')));
const serviceName = `org.murmur.adapter-smoke.${process.pid}.${Date.now()}`;
const ctx = {
  dataDir: path.join(home, 'data'), configPath: path.join(home, 'data', 'agent-config.json'),
  storePath: path.join(home, 'data', 'murmur.db'), repoRoot: path.join(home, 'repo with spaces'),
  nodePath: process.execPath, logDir: path.join(home, 'data', 'logs'), serviceName,
};
const adapter = createDarwinAdapter({ homeDir: home });
const events = [];
let safeToRemove = false;
try {
  await fs.mkdir(path.join(ctx.repoRoot, 'scripts'), { recursive: true });
  await fs.mkdir(ctx.dataDir);
  await fs.writeFile(ctx.configPath, '{}\n', { mode: 0o600 });
  await fs.writeFile(path.join(ctx.repoRoot, 'scripts', 'murmur-daemon.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const fd=fs.openSync(path.join(process.env.DATA_DIR,'murmur.db'),'a+');
console.log('FAKE_DAEMON_READY');
setInterval(()=>fs.fstatSync(fd),1000);
process.on('SIGTERM',()=>{fs.closeSync(fd);process.exit(0)});
`);
  assert.equal((await adapter.status(ctx)).state, 'stopped');
  await adapter.install(ctx);
  events.push({ step: 'install', fileMode: (await fs.stat(path.join(home, 'Library', 'LaunchAgents', serviceName + '.plist'))).mode & 0o777 });
  const started = performance.now();
  await adapter.start(ctx);
  let running;
  for (let attempt = 0; attempt < 30; attempt++) {
    running = await adapter.status(ctx);
    if (running.state === 'running' && running.observedStorePath) break;
    await delay(100);
  }
  assert.equal(running.state, 'running');
  assert.equal(running.observedStorePath, await fs.realpath(ctx.storePath));
  assert.equal(running.restartCount, null); assert.equal(running.restartWindowMs, null);
  events.push({ step: 'start', durationMs: Math.round(performance.now() - started), ...running });
  const firstPid = running.pid;
  await adapter.start(ctx);
  assert.equal((await adapter.status(ctx)).pid, firstPid);
  events.push({ step: 'start-again', samePid: true });
  await adapter.stop(ctx);
  assert.equal((await adapter.status(ctx)).state, 'stopped');
  await adapter.stop(ctx);
  events.push({ step: 'stop-again', state: 'stopped' });
  console.log(JSON.stringify({ result: 'PASS', fakeDaemon: true, serviceName, events, rebootTested: false }, null, 2));
} finally {
  try {
    await adapter.stop(ctx);
    safeToRemove = (await adapter.status(ctx)).state === 'stopped';
  } catch (error) { console.error('Cleanup failed; artifacts retained at', home, error.message); }
  if (safeToRemove) await fs.rm(home, { recursive: true, force: true });
}
