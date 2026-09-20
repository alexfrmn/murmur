import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();

async function invoke(script, args, env) {
  try {
    const { stdout, stderr } = await run(process.execPath, [path.join(root, 'scripts', script), ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('legacy invitation entrypoints stop before profile access and point to the canonical file workflow', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-legacy-deprecation-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const config = path.join(profile, 'agent-config.json');
  const original = Buffer.from('sentinel-profile-bytes');
  await fs.writeFile(config, original, { mode: 0o600 });
  const secret = 'synthetic-command-line-secret';
  const cases = [
    ['murmur-invite.mjs', [], /murmur\.mjs invite --out ABSOLUTE_FILE --data-dir ABSOLUTE_PROFILE/],
    ['murmur-join.mjs', [`MURMUR:${secret}`], /murmur\.mjs join --agent-id ID --invite-file ABSOLUTE_FILE --reply-out ABSOLUTE_FILE --data-dir ABSOLUTE_PROFILE/],
    ['murmur-add-peer.mjs', [`MURMUR-REPLY:${secret}`], /murmur\.mjs add-peer --reply-file ABSOLUTE_FILE --data-dir ABSOLUTE_PROFILE/],
  ];

  for (const [script, args, replacement] of cases) {
    const result = await invoke(script, args, { ...process.env, DATA_DIR: profile });
    assert.notEqual(result.code, 0, `${script} must refuse the removed workflow`);
    assert.equal(result.stdout, '', `${script} must not print a blob or profile data`);
    assert.match(result.stderr, /deprecated/i);
    assert.match(result.stderr, replacement);
    assert.match(result.stderr, /docs\/setup-onboarding\.md/);
    assert.ok(!(result.stdout + result.stderr).includes(secret), `${script} must not echo command-line secrets`);
    assert.deepEqual(await fs.readFile(config), original, `${script} must not mutate the profile`);
  }
});

test('site agent prompts use the canonical invite, join and add-peer file workflow in both languages', async () => {
  const site = await fs.readFile(path.join(root, 'site', 'index.html'), 'utf8');
  for (const legacy of ['scripts/murmur-invite.mjs', 'scripts/murmur-join.mjs', 'scripts/murmur-add-peer.mjs']) {
    assert.ok(!site.includes(legacy), `site still advertises ${legacy}`);
  }
  for (const command of [
    'packages/setup/bin/murmur.mjs invite --out',
    'packages/setup/bin/murmur.mjs join --agent-id',
    'packages/setup/bin/murmur.mjs add-peer --reply-file',
  ]) {
    assert.equal(site.split(command).length - 1, 2, `${command} must appear once per language`);
  }
  assert.match(site, /blob\/v2\.10\.0\/docs\/setup-onboarding\.md/);
  assert.ok(!site.includes('claude mcp add murmur'), 'site must use the shared client-settings writer');
  const prompts = [...site.matchAll(/prompt: `([\s\S]*?)`/g)].map(match => match[1]);
  assert.equal(prompts.length, 2, 'English and Russian prompts must both be present');
  for (const prompt of prompts) {
    const ordered = [
      'murmur.mjs init --agent-id',
      'murmur.mjs invite --out',
      'murmur.mjs join --agent-id',
      'murmur.mjs add-peer --reply-file',
      'scripts/murmur-daemon.mjs',
      'murmur.mjs clients detect',
      'murmur.mjs clients configure',
    ].map(command => prompt.indexOf(command));
    assert.ok(ordered.every(index => index >= 0), 'prompt is missing a canonical setup phase');
    assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), 'pairing must finish before daemon and client startup');
  }
});
