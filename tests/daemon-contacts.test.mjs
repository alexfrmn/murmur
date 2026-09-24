import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDaemonContacts } from '../scripts/daemon-contacts.mjs';
import { isRecoverableRejection } from '../packages/core/dist/src/index.js';
import { skipWithoutSymlinks } from './windows-host.mjs';

function fixture(t, mutate = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'murmur-reload-')), file = path.join(root, 'agent-config.json');
  const key = Buffer.alloc(32, 7).toString('base64');
  const config = { agentId: 'test-a', natsUrl: 'nats://127.0.0.1:1', subject: 'msg.test-a',
    keys: { encryption: { publicKey: key, privateKey: key }, signing: { publicKey: key, privateKey: key } },
    peers: { old: { subject: 'msg.old', encryption: { publicKey: key }, signing: { publicKey: key } } }, wake: { enabled: false } };
  const save = value => { writeFileSync(file + '.new', JSON.stringify(value), { mode: 0o600 }); renameSync(file + '.new', file); };
  mutate(config); save(config); const logs = [];
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
]) test(`reload rejects changed ${name} while retaining the last valid Contacts`, t => {
  const f = fixture(t), next = structuredClone(f.config); mutate(next); f.save(next);
  next.peers.untrusted = next.peers.old; delete next.peers.old; f.save(next);
  assert.deepEqual(f.contacts.refresh(), f.config.peers);
  assert.deepEqual(f.contacts.config.keys, f.config.keys);
  assert.equal(f.contacts.diagnostics().state, 'retained');
  assert.match(f.contacts.diagnostics().lastError, /agent-config-/);
  for (let i = 0; i < 5; i++) f.contacts.refresh();
  assert.equal(f.logs.length, 1, 'a repeated failure must not flood the log');
  f.save(f.config); assert.deepEqual(f.contacts.refresh(), f.config.peers);
  assert.equal(f.contacts.diagnostics().state, 'current');
  assert.equal(f.contacts.diagnostics().lastError, null);
});

test('missing and malformed config retain valid Contacts and recover after atomic repair', t => {
  const f = fixture(t);
  for (const failure of [() => rmSync(f.file), () => writeFileSync(f.file, '{invalid')]) {
    failure(); assert.deepEqual(f.contacts.refresh(), f.config.peers);
    assert.equal(f.contacts.diagnostics().state, 'retained');
    f.save(f.config); assert.deepEqual(f.contacts.refresh(), f.config.peers);
    assert.equal(f.contacts.diagnostics().lastError, null);
  }
  assert.equal(isRecoverableRejection('contacts-unavailable:retry'), true);
});

test('a forced SIGHUP refresh cannot bypass identity pinning', t => {
  const f = fixture(t); f.save({ ...f.config, agentId: 'different' });
  assert.deepEqual(f.contacts.refresh(true), f.config.peers);
  assert.match(f.contacts.diagnostics().lastError, /identity-changed/);
});

test('reload refuses a symlink replacement', { skip: skipWithoutSymlinks }, t => {
  const f = fixture(t), target = path.join(f.root, 'other');
  renameSync(f.file, target); symlinkSync(target, f.file);
  assert.deepEqual(f.contacts.refresh(), f.config.peers);
  assert.match(f.contacts.diagnostics().lastError, /file-invalid/);
});

test('startup skips an invalid Contact without discarding valid Contacts', t => {
  const f = fixture(t, config => { config.peers.bad = { subject: 'msg.bad' }; });
  assert.deepEqual(Object.keys(f.contacts.config.peers), ['old']);
  assert.equal(f.contacts.diagnostics().state, 'partial');
  assert.equal(f.contacts.diagnostics().invalidCount, 1);
  assert.equal(f.contacts.diagnostics().lastError, 'agent-config-peer-invalid');
  assert.deepEqual(f.logs, [{ msg: 'Invalid Contacts skipped', reason: 'agent-config-peer-invalid', contacts: ['bad'], count: 1 }]);
});

test('reload isolates bad Contacts and applies valid replacements and removals', t => {
  const f = fixture(t), next = structuredClone(f.config);
  next.peers.new = structuredClone(next.peers.old);
  next.peers.old.signing.publicKey = 'invalid';
  next.peers['invalid id with private text'] = next.peers.new;
  f.save(next);
  assert.deepEqual(Object.keys(f.contacts.refresh()), ['new']);
  assert.equal(f.contacts.diagnostics().invalidCount, 2);
  assert.ok(!JSON.stringify(f.logs).includes('private text'));
  const count = f.logs.length;
  f.save(next); f.contacts.refresh(); f.contacts.refresh(true);
  assert.equal(f.logs.length, count, 'identical invalid entries are reported once');
  delete next.peers.old; delete next.peers['invalid id with private text']; delete next.peers.new;
  f.save(next); assert.deepEqual(f.contacts.refresh(), {});
  assert.equal(f.contacts.diagnostics().state, 'current');
});

test('an unchanged file rewritten or forced by another cache does not log a reload', t => {
  const f = fixture(t);
  f.save(f.config); f.contacts.refresh(); f.contacts.refresh(true);
  assert.deepEqual(f.logs, []);
});
