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

async function invoke(t, config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-legacy-invite-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'agent-config.json'), JSON.stringify({
    agentId: 'agent-a', subject: 'msg.agent-a',
    keys: { encryption: { publicKey: 'enc-public' }, signing: { publicKey: 'sign-public' } },
    ...config }), { mode: 0o600 });
  try {
    const { stdout, stderr } = await run(process.execPath, [script], { env: { ...process.env, DATA_DIR: root } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const profile = async (t, config) => (await invoke(t, config)).stdout;

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

// Review found this one: two spaces in front of the URL defeated an anchored
// regex, so the profile read as credential-free and the password was printed.
// The NATS client trims the value, which makes this the same address, not a
// made-up format.
test('whitespace in front of the URL does not hide the credential', async t => {
  const out = await profile(t, { natsUrl: '  nats://alice:leading-secret@broker.example:4222  ' });
  assert.match(out, /password/i, 'a trimmed address is the same address');
  assert.ok(!out.includes('leading-secret'), 'the credential must not survive into stdout');
  assert.match(out, /nats:\/\/\*\*\*@broker\.example:4222/);
});

test('an address the script cannot vouch for stops it before any output', async t => {
  for (const natsUrl of ['http://broker.example:4222', 'nats://broker.example:4222?token=synthetic',
                         'nats://broker.example:4222#synthetic', 'not-a-url']) {
    const r = await invoke(t, { natsUrl, natsToken: 'synthetic-token' });
    assert.equal(r.code, 1, `${natsUrl} must be refused`);
    assert.ok(!r.stdout.includes('MURMUR:'), `${natsUrl} must not reach a blob`);
    assert.ok(!(r.stdout + r.stderr).includes('synthetic-token'), `${natsUrl} must not leak the token`);
    assert.match(r.stderr, /not usable/);
    assert.match(r.stderr, /murmur invite --out/, 'a refusal has to say where to go instead');
  }
});
