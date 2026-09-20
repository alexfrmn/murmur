// The legacy script is what the agent prompts on the site tell a newcomer to run.
// It has to warn before it prints the secret, and it must not echo a credential
// that is hidden in the broker URL. No live credentials: synthetic profiles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const script = path.join(process.cwd(), 'scripts', 'murmur-invite.mjs');

async function profile(t, config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-legacy-invite-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'agent-config.json'), JSON.stringify({
    agentId: 'agent-a', subject: 'msg.agent-a',
    keys: { encryption: { publicKey: 'enc-public' }, signing: { publicKey: 'sign-public' } },
    ...config }), { mode: 0o600 });
  const { stdout } = await run(process.execPath, [script], { env: { ...process.env, DATA_DIR: root } });
  return stdout;
}

test('a blob carrying a broker token is called a password before it is printed', async t => {
  const out = await profile(t, { natsUrl: 'nats://broker.example:4222', natsToken: 'synthetic-token' });
  const warning = out.indexOf('password'), secret = out.indexOf('MURMUR:');
  assert.notEqual(warning, -1, 'the warning must name the risk in the word a person acts on');
  assert.ok(warning < secret, 'the warning must come before the secret, not after it');
  assert.match(out, /credential/i);
  assert.match(out, /does not prove pairing/);
});

test('a blob without a credential is not called a password', async t => {
  const out = await profile(t, { natsUrl: 'nats://broker.example:4222' });
  assert.ok(!/password/i.test(out), 'calling a harmless file a password teaches people to ignore the word');
  assert.match(out, /identity/i);
  assert.match(out, /does not prove pairing/);
});

test('a credential hidden in the broker URL still triggers the warning and is never echoed', async t => {
  const out = await profile(t, { natsUrl: 'nats://alice:s3cr3t@broker.example:4222' });
  assert.match(out, /password/i, 'userinfo in the URL is a credential too');
  assert.ok(!out.includes('s3cr3t'), 'the credential must not be echoed into the shell history');
  assert.match(out, /nats:\/\/\*\*\*@broker\.example:4222/, 'the printed URL is masked, not dropped');
});
