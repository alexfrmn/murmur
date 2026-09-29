import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePeers } from '../packages/setup/dist/src/doctor.js';

// A profile with many contacts: two have fresh two-way proofs, one was never probed.
const list = [
  { agentId: 'agent-mac', paired: true },
  { agentId: 'agent-old', paired: null },
  { agentId: 'agent-win', paired: true },
];

test('doctor --peer judges the selected peer, not every configured contact (#282)', () => {
  const ok = evaluatePeers(list, 'agent-mac');
  assert.equal(ok.state, undefined);
  assert.equal(ok.reason, undefined);
  assert.match(ok.detail, /agent-mac/);

  const warn = evaluatePeers(list, 'agent-old');
  assert.equal(warn.state, 'warn');
  assert.equal(warn.reason, 'peers.unmeasured');
  assert.match(warn.detail, /agent-old/);
  assert.match(warn.fixHint, /--peer/);
});

test('without --peer the stage counts measured contacts and keeps the warning', () => {
  const warn = evaluatePeers(list);
  assert.equal(warn.state, 'warn');
  assert.equal(warn.reason, 'peers.unmeasured');
  assert.match(warn.detail, /2 of 3/);
  assert.equal(evaluatePeers(list.filter(p => p.paired === true)).state, undefined);
  assert.equal(evaluatePeers([]).state, undefined);
});
