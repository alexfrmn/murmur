// A writer on a rollback-journal store must not silently kill the Stop listener.
// Keep the writer in the parent process so the test holds a real SQLite lock.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { skipPosixShell } from './windows-host.mjs';

const nodeScript = path.resolve('scripts/wake-drain-claude.mjs');
const shellScript = path.resolve('scripts/wake-drain-claude.sh');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`child did not close within ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmur-wake-busy- Мой-'));
  const dbPath = path.join(root, 'murmur.db');
  const cursor = path.join(root, 'cursor');
  const anchor = path.join(root, 'anchor');
  const ledger = path.join(root, 'skipped.jsonl');
  fs.writeFileSync(cursor, '1\n');
  fs.writeFileSync(anchor, '1\n');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=DELETE;
    CREATE TABLE local_messages (msg_id TEXT PRIMARY KEY, created_at TEXT, sender TEXT,
      conversation_id TEXT, direction TEXT, text TEXT, wake_eligible INTEGER);`);
  const insert = (id, conversation = 'chat', eligible = 1) => db.prepare(
    "INSERT INTO local_messages VALUES (?, '2026-09-24T00:00:00Z', 'agent-peer', ?, 'inbound', 'private peer body', ?)",
  ).run(id, conversation, eligible);
  insert('baseline');
  const children = [];
  const start = (args = [], shell = false) => {
    const child = spawn(shell ? 'bash' : process.execPath,
      shell ? [shellScript] : ['--no-warnings', nodeScript, ...args], {
        env: {
          ...process.env, HOME: root, USERPROFILE: root, MURMUR_DB: dbPath,
          MURMUR_WAKE_CURSOR: cursor, MURMUR_WAKE_ANCHOR: anchor,
          MURMUR_WAKE_LOCK: path.join(root, 'lock'), MURMUR_WAKE_SKIPPED_LOG: ledger,
          MURMUR_WAKE_POLL_MS: '100', MURMUR_WAKE_MAX_SECONDS: '15',
          MURMUR_WAKE_SKIP_SENDERS: '', MURMUR_WAKE_SKIP_CONVERSATIONS: '',
          MURMUR_WAKE_SKIP_INELIGIBLE: '',
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    const result = { child, closed: false, stderr: '', stdout: '' };
    child.stderr.on('data', chunk => { result.stderr += chunk; });
    child.stdout.on('data', chunk => { result.stdout += chunk; });
    result.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { result.closed = true; resolve({ code, stderr: result.stderr, stdout: result.stdout }); });
    });
    children.push(result);
    return result;
  };
  t.after(async () => {
    for (const result of children) {
      if (!result.closed) result.child.kill();
      await bounded(result.done, 5000);
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const hold = () => {
    db.exec('BEGIN EXCLUSIVE');
    insert('diagnostic', 'murmur:doctor:nonce:request', 0);
    insert('new-message');
  };
  const unchanged = () => {
    assert.equal(fs.readFileSync(cursor, 'utf8').trim(), '1');
    assert.equal(fs.readFileSync(anchor, 'utf8').trim(), '1');
    assert.equal(fs.existsSync(ledger), false, 'no rows were read, so none may enter the skipped ledger');
  };
  const woke = (result, shell = false) => {
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Murmur wake: 1 new inbound message/);
    assert.match(result.stderr, /rowid=3 \[agent-peer\]/);
    assert.doesNotMatch(result.stderr, /rowid=2|private peer body/);
    assert.equal(fs.readFileSync(cursor, 'utf8').trim(), '3');
    // Only the Node drain owns the cross-session anchor.
    assert.equal(fs.readFileSync(anchor, 'utf8').trim(), shell ? '1' : '3');
    const skipped = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(skipped.map(row => [row.rowid, row.reason]), [[2, 'doctor-protocol']]);
  };
  return { db, start, hold, unchanged, woke, cursor, anchor, ledger };
}

for (const mode of ['poll', 'once', 'shell']) {
  test(`${mode} waits for a 1.3s writer lock and wakes only after commit`, {
    timeout: 15000, skip: mode === 'shell' && skipPosixShell,
  }, async t => {
    const h = fixture(t);
    h.hold();
    const child = h.start(mode === 'once' ? ['--once'] : [], mode === 'shell');
    await pause(1300);
    assert.equal(child.closed, false, child.stderr);
    h.unchanged();
    h.db.exec('COMMIT');
    const result = await bounded(child.done, 8000);
    h.woke(result, mode === 'shell');
  });
}

test('poll retries after the five-second busy timeout without advancing cursor or waking diagnostics', { timeout: 20000 }, async t => {
  const h = fixture(t);
  h.hold();
  const child = h.start();
  const until = Date.now() + 9000;
  while (!child.closed && !child.stderr.includes('store busy; retrying') && Date.now() < until) await pause(100);
  assert.equal(child.closed, false, child.stderr);
  assert.match(child.stderr, /store busy; retrying/);
  assert.equal(child.stderr.match(/store busy; retrying/g).length, 1);
  h.unchanged();
  h.db.exec('COMMIT');
  h.woke(await bounded(child.done, 8000));
});

test('polling deadline bounds a locked read and preserves the next invocation’s message', { timeout: 10000 }, async t => {
  const h = fixture(t);
  h.hold();
  const started = Date.now();
  const child = h.start(['--max-seconds', '1']);
  const result = await bounded(child.done, 4000);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /drain failed: database is locked/);
  assert.ok(Date.now() - started < 3500, 'do not spend the full 5s busy timeout after a 1s polling deadline');
  h.unchanged();
  h.db.exec('COMMIT');
  h.woke(await bounded(h.start(['--once']).done, 4000));
});

test('non-contention read errors exit once without falsely waking or advancing the cursor', { timeout: 5000 }, async t => {
  const h = fixture(t);
  h.db.exec('DROP TABLE local_messages');
  const result = await bounded(h.start().done, 3000);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /no such table/);
  assert.doesNotMatch(result.stderr, /store busy; retrying/);
  h.unchanged();
});
