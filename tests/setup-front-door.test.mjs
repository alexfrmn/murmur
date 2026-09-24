import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Exactly what a new user runs: the real bin, no NODE_NO_WARNINGS, no NODE_OPTIONS from the test runner.
const env = { ...process.env }; delete env.NODE_NO_WARNINGS; delete env.NODE_OPTIONS;
const murmur = (...args) => spawnSync(process.execPath, ['packages/setup/bin/murmur.mjs', ...args], { cwd: root, encoding: 'utf8', env });

test('murmur --version and -v answer like murmur version', () => {
  for (const args of [['--version'], ['-v'], ['--version', '--json']]) {
    const run = murmur(...args);
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
    const reply = JSON.parse(run.stdout);
    assert.equal(reply.schema, 'murmur.version/1'); assert.equal(reply.version, declared);
  }
});

test('an unknown option is actionable for people and retains its diagnostic code in JSON mode', () => {
  const run = murmur('status', '--no-such-option');
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'This option is not available. Run with --help to check the command.');
  const json = murmur('status', '--no-such-option', '--json');
  assert.equal(json.status, 1);
  assert.equal(json.stderr.trim(), 'cli.unknown-option');
});

test('the SQLite ExperimentalWarning is not printed on every command', () => {
  // The warning exists in this Node: otherwise the assertion below would prove nothing.
  const bare = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('node:sqlite')"], { encoding: 'utf8', env });
  if (!/ExperimentalWarning: SQLite/.test(bare.stderr)) return;
  for (const args of [['version'], ['--help']]) {
    const run = murmur(...args);
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stderr, /ExperimentalWarning/, args.join(' '));
  }
});
