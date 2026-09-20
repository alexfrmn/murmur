import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const hash = value => createHash('sha256').update(value).digest('hex');
const run = (file, args, options = {}) => spawnSync(file, args, {
  encoding: 'utf8', windowsHide: true, timeout: 10_000, ...options,
});
const decodeLauncher = command => {
  const match = /^powershell -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.ok(match, `unexpected launcher: ${command}`);
  const source = Buffer.from(match[1], 'base64').toString('utf16le');
  const config = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(source);
  assert.ok(config, `missing encoded config: ${source}`);
  return JSON.parse(Buffer.from(config[1], 'base64').toString('utf8'));
};

test('Windows Claude statusline executes encoded paths and preserves stdin and settings', { skip: !windows }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-claude-native-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const special = path.join(base, "%MURMUR_NATIVE_PATH_TOKEN% apostrophe's space");
  const scripts = path.join(special, "plugin scripts' %MURMUR_NATIVE_SCRIPT%");
  const dataDir = path.join(special, "profile's data");
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  for (const name of ['configure-statusline.mjs', 'statusline.mjs']) {
    await fs.copyFile(path.join(root, 'plugins', 'claude-code', 'scripts', name), path.join(scripts, name));
  }
  const marker = path.join(base, 'fixture-runs.txt');
  const entrypoint = path.join(special, "fixture cli's entrypoint.mjs");
  await fs.writeFile(entrypoint, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (args.length !== 4 || args[0] !== 'status' || args[1] !== '--line' || args[2] !== '--data-dir' || path.resolve(args[3]) !== path.resolve(process.env.MURMUR_NATIVE_EXPECTED_DATA)) process.exit(3);",
    "fs.appendFileSync(process.env.MURMUR_NATIVE_MARKER, 'run\\n');",
    "process.stdout.write('Murmur: 7 unread\\n');",
  ].join('\n'));
  const settings = path.join(special, "settings' %MURMUR_NATIVE_SETTINGS%.json");
  const existing = "$raw=[Console]::In.ReadToEnd();$value=$raw|ConvertFrom-Json;[Console]::Out.Write('legacy:'+$value.model.id)";
  const original = Buffer.from(JSON.stringify({ statusLine: { type: 'command', command: existing,
    padding: 1, refreshInterval: 2 }, unrelated: { preserved: true } }, null, 2));
  await fs.writeFile(settings, original);
  const beforeHash = hash(original);
  const configure = path.join(scripts, 'configure-statusline.mjs');
  const configureArgs = [configure, '--dry-run', '--settings', settings, '--data-dir', dataDir,
    '--node-bin', process.execPath, '--murmur-entrypoint', entrypoint, '--existing-shell', 'powershell'];
  const proposalResult = run(process.execPath, configureArgs);
  assert.equal(proposalResult.status, 0, proposalResult.stderr);
  const proposal = JSON.parse(proposalResult.stdout);
  assert.equal(proposal.writesPerformed, false);
  assert.equal(proposal.preservedExistingCommand, true);
  assert.equal(proposal.proposedStatusLine.padding, 1);
  assert.equal(proposal.proposedStatusLine.refreshInterval, 2);
  assert.equal(hash(await fs.readFile(settings)), beforeHash);
  assert.doesNotMatch(proposal.proposedStatusLine.command, /MURMUR_NATIVE_PATH_TOKEN|apostrophe|profile/);
  const config = decodeLauncher(proposal.proposedStatusLine.command);
  assert.ok(config.args.includes(dataDir.replaceAll('\\', '/')));
  assert.ok(config.args.includes(entrypoint.replaceAll('\\', '/')));

  const input = JSON.stringify({ model: { id: 'claude-native-fixture' } });
  const rendered = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    proposal.proposedStatusLine.command], { input, env: { ...process.env,
      MURMUR_NATIVE_PATH_TOKEN: 'EXPANDED-WRONG', MURMUR_NATIVE_SCRIPT: 'EXPANDED-WRONG',
      MURMUR_NATIVE_SETTINGS: 'EXPANDED-WRONG', MURMUR_NATIVE_EXPECTED_DATA: dataDir,
      MURMUR_NATIVE_MARKER: marker } });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout.replaceAll('\r\n', '\n'), 'legacy:claude-native-fixture\nMurmur: 7 unread\n');
  assert.equal(await fs.readFile(marker, 'utf8'), 'run\n');
  assert.equal(hash(await fs.readFile(settings)), beforeHash);

  const malformed = run(process.execPath, [configure, '--dry-run', '--settings', settings,
    '--data-dir', 'relative-profile', '--node-bin', process.execPath, '--murmur-entrypoint', entrypoint,
    '--existing-shell', 'powershell']);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /data-dir-invalid/);
  assert.equal(hash(await fs.readFile(settings)), beforeHash);
  assert.equal(await fs.readFile(marker, 'utf8'), 'run\n');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugins', 'claude-code', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.defaultEnabled, false);
});

test('Windows Git Bash resolver uses configured or adjacent Git Bash and rejects WSL-shaped paths', { skip: !windows }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-git-bash-native-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const git = path.join(base, 'Portable Git');
  const gitCmd = path.join(git, 'cmd'), gitBin = path.join(git, 'bin');
  await fs.mkdir(gitCmd, { recursive: true });
  await fs.mkdir(gitBin, { recursive: true });
  await fs.writeFile(path.join(gitCmd, 'git.exe'), 'fixture');
  const bash = path.join(gitBin, 'bash.exe');
  await fs.writeFile(bash, 'fixture');
  const settings = path.join(base, 'settings.json'), dataDir = path.join(base, 'data');
  const entrypoint = path.join(base, 'fixture.mjs');
  await fs.mkdir(dataDir);
  await fs.writeFile(entrypoint, "process.stdout.write('Murmur: 1 unread\\n');\n");
  await fs.writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: "printf 'legacy'" } }));
  const configure = path.join(root, 'plugins', 'claude-code', 'scripts', 'configure-statusline.mjs');
  const common = [configure, '--dry-run', '--settings', settings, '--data-dir', dataDir,
    '--node-bin', process.execPath, '--murmur-entrypoint', entrypoint, '--existing-shell', 'bash'];

  const configured = run(process.execPath, common, { env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: bash } });
  assert.equal(configured.status, 0, configured.stderr);
  const configuredArgs = decodeLauncher(JSON.parse(configured.stdout).proposedStatusLine.command).args;
  assert.deepEqual(configuredArgs.slice(-2), ['--existing-shell-path', bash.replaceAll('\\', '/')]);

  const adjacentEnv = { ...process.env, PATH: `${gitCmd}${path.delimiter}${process.env.PATH ?? ''}` };
  delete adjacentEnv.CLAUDE_CODE_GIT_BASH_PATH;
  const adjacent = run(process.execPath, common, { env: adjacentEnv });
  assert.equal(adjacent.status, 0, adjacent.stderr);
  const adjacentArgs = decodeLauncher(JSON.parse(adjacent.stdout).proposedStatusLine.command).args;
  assert.deepEqual(adjacentArgs.slice(-2), ['--existing-shell-path', bash.replaceAll('\\', '/')]);

  const emptyConfigured = run(process.execPath, common, { env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: '' } });
  assert.notEqual(emptyConfigured.status, 0, 'an explicitly empty Claude Git Bash path must fail instead of falling through');

  const wslShape = path.join(base, 'Windows', 'System32', 'bash.exe');
  await fs.mkdir(path.dirname(wslShape), { recursive: true });
  await fs.writeFile(wslShape, 'fixture');
  const rejected = run(process.execPath, [...common, '--existing-shell-path', wslShape], { env: adjacentEnv });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /git-bash-path-not-git-for-windows/);
});
