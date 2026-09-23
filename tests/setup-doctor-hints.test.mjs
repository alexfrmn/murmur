import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../packages/setup/dist/src/cli.js';
import { runDoctor } from '../packages/setup/dist/src/doctor.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';

const stopped = { manager: 'none', status: async () => ({ state: 'stopped', manager: 'none', pid: null, since: null, lastExitCode: null, observedStorePath: null, restartCount: null, restartWindowMs: null }) };

test('doctor tells a new user the next command for a missing profile and a stopped service', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-doctor-hints- пробел кириллица-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'profile'), context = resolveContext({ dataDir });

  const missing = await runDoctor({ context, adapter: stopped });
  assert.equal(missing.summary.failedStage, 'config');
  assert.equal(missing.stages[0].reason, 'config.missing');
  assert.match(missing.stages[0].fixHint, /murmur join --data-dir/);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });

  await main(['init', '--agent-id', 'agent-a', '--broker-url', 'nats://127.0.0.1:4222', '--data-dir', dataDir], stopped);
  const down = await runDoctor({ context, adapter: stopped });
  assert.equal(down.summary.failedStage, 'daemon');
  assert.equal(down.stages[1].reason, 'daemon.not-running');
  assert.match(down.stages[1].fixHint, /murmur service install --data-dir <this profile> --service-name murmur-[0-9a-f]{12} /);
  // Skipped stages and an unknown failure keep null: a hint is only given where the next step is known.
  assert.ok(down.stages.slice(2).every(s => s.fixHint === null));

  // A custom service chosen with --service-name must survive into the suggested command.
  const custom = await runDoctor({ context: resolveContext({ dataDir, serviceName: 'MurmurCodexWin' }), adapter: stopped });
  assert.match(custom.stages[1].fixHint, / --service-name MurmurCodexWin /);
  assert.doesNotMatch(custom.stages[1].fixHint, /murmur-[0-9a-f]{12}/);
});
