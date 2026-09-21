import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SQLiteMessageStore } from '../packages/core/dist/src/index.js';
import { createKeyPair, createSigningKeyPair } from '../packages/security/dist/src/index.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { prepareReplyTest, checkReplyTest } from '../packages/setup/dist/src/reply-test.js';
import { main } from '../packages/setup/dist/src/cli.js';
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-reply-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const context = resolveContext({ dataDir });
  const keys = { signing: await createSigningKeyPair(), encryption: await createKeyPair() };
  const config = { agentId: 'alice', subject: 'msg.alice', natsUrl: 'nats://127.0.0.1:4222', keys,
    peers: { bob: { subject: 'msg.bob', signing: { publicKey: keys.signing.publicKey }, encryption: { publicKey: keys.encryption.publicKey } } } };
  await fs.writeFile(context.configPath, JSON.stringify(config), { mode: 0o600 });
  const store = new SQLiteMessageStore(context.storePath); t.after(() => store.close());
  const cursor = path.join(dataDir, 'read-state.json'); await fs.writeFile(cursor, '{"fixture":"unchanged"}');
  const plan = await prepareReplyTest(context, 'bob');
  const append = (direction, patch = {}) => store.append({ msgId: randomUUID(), conversationId: plan.conversationId,
    sender: direction === 'outbound' ? 'alice' : 'bob', direction,
    text: direction === 'outbound' ? plan.requestText : plan.expectedReply, createdAt: new Date().toISOString(), ...patch });
  return { context, config, plan, store, cursor, append, check: () => checkReplyTest(context, plan.token) };
}
test('preparing does not send; only matching outbound and inbound complete the test without marking read', async t => {
  const f = await fixture(t), before = await fs.readFile(f.cursor);
  assert.equal((await f.check()).state, 'not-sent');
  await f.append('inbound');
  assert.equal((await f.check()).state, 'not-sent', 'even a matching inbound alone does not prove use of the selected local client profile');
  await f.append('outbound');
  const result = await f.check();
  assert.equal(result.state, 'replied'); assert.ok(result.replyMsgId && result.requestMsgId && result.receivedAt);
  assert.ok(!JSON.stringify(result).includes(f.plan.expectedReply), 'receipt does not expose message bodies');
  assert.deepEqual(await fs.readFile(f.cursor), before);
});
for (const wrong of ['peer', 'conversation', 'nonce', 'old-time', 'future-time', 'direction', 'channel', 'member']) {
  test(`does not accept a reply with wrong ${wrong}`, async t => {
    const f = await fixture(t); await f.append('outbound');
    const patch = {
      peer: { sender: 'mallory' }, conversation: { conversationId: 'other-conversation' }, nonce: { text: 'MURMUR-SETUP-REPLY wrong' },
      'old-time': { createdAt: new Date(Date.now() - 60000).toISOString() },
      'future-time': { createdAt: new Date(Date.now() + 60000).toISOString() },
      direction: { direction: 'outbound' }, channel: { channelId: 'wrong-channel' }, member: { senderMemberId: 'wrong-member' },
    }[wrong];
    await f.append('inbound', patch); assert.equal((await f.check()).state, 'waiting');
  });
}
test('plan expires, changed profile refuses, malformed token does not read arbitrary state', async t => {
  const f = await fixture(t);
  const expired = JSON.parse(Buffer.from(f.plan.token, 'base64url').toString());
  expired.createdAt = new Date(Date.now() - 16 * 60000).toISOString();
  assert.equal((await checkReplyTest(f.context, Buffer.from(JSON.stringify(expired)).toString('base64url'))).state, 'expired');
  for (const token of ['!', 'bnVsbA', 'e30']) await assert.rejects(checkReplyTest(f.context, token), /token-invalid/);
  f.config.agentId = 'other'; f.config.subject = 'msg.other';
  await fs.writeFile(f.context.configPath, JSON.stringify(f.config));
  await assert.rejects(f.check(), /profile-changed/);
});
test('CLI exposes read-only prepare/check; unknown peer and absent DB are not green', async t => {
  const f = await fixture(t);
  const plan = await main(['reply-test', 'prepare', '--peer', 'bob', '--data-dir', f.context.dataDir]);
  assert.equal((await main(['reply-test', 'check', '--test-token', plan.token, '--data-dir', f.context.dataDir])).state, 'not-sent');
  await assert.rejects(prepareReplyTest(f.context, 'unknown'), /peer-invalid/);
  const missing = { ...f.context, storePath: path.join(f.context.dataDir, 'absent.db') };
  await assert.rejects(checkReplyTest(missing, plan.token));
  await assert.rejects(fs.stat(missing.storePath), { code: 'ENOENT' });
});
