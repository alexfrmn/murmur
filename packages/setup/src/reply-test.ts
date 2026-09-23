import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, validAgentId } from './config.js';
import { pairFingerprint } from './status.js';
import type { ServiceContext } from './types.js';

const duration = 15 * 60 * 1000;
interface Challenge { version: 1; agentId: string; peerId: string; fingerprint: string; nonce: string; createdAt: string }
const conversation = (c: Challenge) => `murmur:setup:${c.nonce}`;
const reply = (c: Challenge) => `MURMUR-SETUP-REPLY ${c.nonce}`;
const request = (c: Challenge) => `Murmur connection test from ${c.agentId}. Use murmur_send to reply to ${c.agentId} in this same conversation with exactly this line: ${reply(c)}`;
// Agent identities/signatures may surround the protocol line, but a substring
// inside an explanation or blockquote is not a completed request/reply.
const hasProtocolLine = (text: string, expected: string) => text.split(/\r?\n/).some(line => line.trim() === expected);

/** Preparing instructions never sends a message or writes any profile state. */
export async function prepareReplyTest(context: ServiceContext, peerId: string) {
  const config = await loadConfig(context);
  if (!validAgentId(peerId) || !config.peers[peerId] || peerId === config.agentId) throw new Error('reply-test.peer-invalid');
  const challenge: Challenge = { version: 1, agentId: config.agentId, peerId, fingerprint: pairFingerprint(config, peerId),
    nonce: randomBytes(24).toString('hex'), createdAt: new Date().toISOString() };
  return { schema: 'murmur.reply-test-plan/1', agentId: config.agentId, peerId, conversationId: conversation(challenge),
    token: Buffer.from(JSON.stringify(challenge)).toString('base64url'), createdAt: challenge.createdAt,
    expiresAt: new Date(Date.parse(challenge.createdAt) + duration).toISOString(),
    requestText: request(challenge), expectedReply: reply(challenge) };
}

/** Inspect only this test's durable rows; do not consume inbox state or poll NATS. */
export async function checkReplyTest(context: ServiceContext, token: string) {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('reply-test.token-invalid');
  let test: Challenge;
  try { test = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); }
  catch { throw new Error('reply-test.token-invalid'); }
  const now = Date.now(), start = Date.parse(test?.createdAt), end = start + duration;
  if (test?.version !== 1 || !validAgentId(test.agentId) || !validAgentId(test.peerId)
    || typeof test.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(test.nonce)
    || typeof test.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(test.fingerprint)
    || !Number.isFinite(start) || start > now + 5000) throw new Error('reply-test.token-invalid');
  const config = await loadConfig(context), peer = config.peers[test.peerId];
  if (config.agentId !== test.agentId || !peer || pairFingerprint(config, test.peerId) !== test.fingerprint) throw new Error('reply-test.profile-changed');
  const db = new DatabaseSync(context.storePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const sent = db.prepare(`SELECT msg_id AS msgId, created_at AS createdAt, text, channel_id AS channelId,
      sender_member_id AS senderMemberId, addressee_member_id AS addresseeMemberId FROM local_messages
      WHERE direction='outbound' AND sender=? AND conversation_id=? ORDER BY rowid DESC LIMIT 100`)
      .all(test.agentId, conversation(test)) as Record<string, any>[];
    const received = db.prepare(`SELECT msg_id AS msgId, created_at AS createdAt, text, channel_id AS channelId,
      sender_member_id AS senderMemberId, addressee_member_id AS addresseeMemberId FROM local_messages
      WHERE direction='inbound' AND sender=? AND conversation_id=?
      ORDER BY rowid DESC LIMIT 100`).all(test.peerId, conversation(test)) as Record<string, any>[];
    db.exec('COMMIT');
    const inWindow = (row: Record<string, any>) => {
      const at = Date.parse(row.createdAt);
      return Number.isFinite(at) && at >= start - 5000 && at <= Math.min(end, now + 5000);
    };
    const routing = (row: Record<string, any>, inbound: boolean) =>
      (row.channelId ?? null) === (peer.channelId ?? null)
      && (row.senderMemberId ?? null) === ((inbound ? peer.memberId : config.memberId) ?? null)
      && (row.addresseeMemberId ?? null) === ((inbound ? config.memberId : peer.memberId) ?? null);
    const outbound = sent.find(row => hasProtocolLine(row.text, request(test)) && inWindow(row) && routing(row, false));
    const inbound = outbound && received.find(row => inWindow(row) && routing(row, true)
      && hasProtocolLine(row.text, reply(test))
      && Date.parse(row.createdAt) >= Date.parse(outbound.createdAt) - 5000);
    return { schema: 'murmur.reply-test/1', generatedAt: new Date(now).toISOString(), agentId: config.agentId,
      peerId: test.peerId, conversationId: conversation(test),
      state: inbound ? 'replied' : now > end ? 'expired' : outbound ? 'waiting' : 'not-sent',
      requestMsgId: outbound?.msgId ?? null, replyMsgId: inbound?.msgId ?? null, receivedAt: inbound?.createdAt ?? null };
  } finally { db.close(); }
}
