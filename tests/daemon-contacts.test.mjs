import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDaemonContacts } from '../scripts/daemon-contacts.mjs';
import { isRecoverableRejection } from '../packages/core/dist/src/index.js';
import { skipWithoutSymlinks } from './windows-host.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'murmur-reload-')), file = path.join(root, 'agent-config.json');
  const key = Buffer.alloc(32, 7).toString('base64');
  const config = { agentId: 'test-a', natsUrl: 'nats://127.0.0.1:1', subject: 'msg.test-a',
    keys: { encryption: { publicKey: key, privateKey: key }, signing: { publicKey: key, privateKey: key } },
    peers: { old: { subject: 'msg.old', encryption: { publicKey: key }, signing: { publicKey: key } } }, wake: { enabled: false } };
  const save = value => { writeFileSync(file + '.new', JSON.stringify(value), { mode: 0o600 }); renameSync(file + '.new', file); };
  save(config); const logs = [];
  const contacts = createDaemonContacts(file, (_level, msg, data) => logs.push({ msg, ...data }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file, config, save, contacts, logs };
}

test('atomic Contact replacement is visible to existing responders without restarting', t => {
  const f = fixture(t), reference = f.contacts.config;
  const next = structuredClone(f.config); next.peers.new = next.peers.old; delete next.peers.old;
  f.save(next); f.contacts.refresh();
  assert.equal(f.contacts.config, reference); assert.deepEqual(Object.keys(reference.peers), ['new']);
  assert.equal(reference.wake.enabled, false); assert.deepEqual(reference.keys, f.config.keys);
  assert.deepEqual(f.logs, [{ msg: 'Contacts reloaded', count: 1 }]);
  f.contacts.refresh(); assert.equal(f.logs.length, 1);
});

for (const [name, mutate] of [
  ['Identity', c => { c.agentId = 'another'; }],
  ['keys', c => { c.keys.signing.privateKey = Buffer.alloc(32, 8).toString('base64'); }],
  ['Server', c => { c.natsUrl = 'nats://different.invalid:4222'; }],
  ['routing', c => { c.subject = 'msg.changed'; }],
  ['malformed Contact', c => { c.peers.old.signing.publicKey = 'synthetic-invalid'; }],
]) test(`reload rejects changed ${name} and keeps no stale trust`, t => {
  const f = fixture(t), next = structuredClone(f.config); mutate(next); f.save(next);
  assert.throws(() => f.contacts.refresh(), /agent-config-/);
  assert.deepEqual(f.contacts.config.peers, {});
  f.save(f.config); assert.deepEqual(f.contacts.refresh(), f.config.peers);
});

test('missing and malformed config fail closed and recover after atomic repair', t => {
  const f = fixture(t);
  for (const failure of [() => rmSync(f.file), () => writeFileSync(f.file, '{invalid')]) {
    failure(); assert.throws(() => f.contacts.refresh()); assert.deepEqual(f.contacts.config.peers, {});
    f.save(f.config); assert.deepEqual(f.contacts.refresh(), f.config.peers);
  }
  assert.equal(isRecoverableRejection('contacts-unavailable:retry'), true);
});

test('a forced SIGHUP refresh cannot bypass identity pinning', t => {
  const f = fixture(t); f.save({ ...f.config, agentId: 'different' });
  assert.throws(() => f.contacts.refresh(true), /identity-changed/);
  assert.deepEqual(f.contacts.config.peers, {});
});

test('reload refuses a symlink replacement', { skip: skipWithoutSymlinks }, t => {
  const f = fixture(t), target = path.join(f.root, 'other');
  renameSync(f.file, target); symlinkSync(target, f.file);
  assert.throws(() => f.contacts.refresh(), /file-invalid/);
  assert.deepEqual(f.contacts.config.peers, {});
});
