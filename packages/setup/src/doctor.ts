import { connect, StringCodec, type NatsConnection } from 'nats';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { buildNatsConnectionOptions } from '@murmurv2/broker-nats';
import { SQLiteDedupeOutboxStore, stableEnvelopePayload, isEnvelopeV1, type EnvelopeV1 } from '@murmurv2/core';
import { encryptPayload, signEnvelope, verifyEnvelopeSignature, decryptPayload } from '@murmurv2/security';
import { loadConfig, readJson, safeError, type AgentConfig } from './config.js';
import { pairFingerprint, readStatus } from './status.js';
import { writeState } from './state.js';
import type { ServiceContext, PlatformAdapter } from './types.js';

export interface DoctorOptions { context: ServiceContext; adapter: PlatformAdapter; peer?: string; timeoutMs?: number }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function probeRoundtrip(c: ServiceContext, config: AgentConfig, peerId: string, connection: NatsConnection, timeoutMs: number) {
  const peer = config.peers[peerId];
  if (!peer) throw new Error('peers.unknown');
  const nonce = randomBytes(24).toString('hex'), conversationId = `murmur:doctor:${randomUUID()}`;
  const text = `Murmur diagnostic roundtrip. Reply in this same conversation with exactly this line: MURMUR-DOCTOR-REPLY ${nonce}`;
  const payload = await encryptPayload(text, peer.encryption.publicKey, config.keys.encryption.privateKey);
  const envelope: EnvelopeV1 = { schemaVersion: '1.0', msgId: randomUUID(), conversationId, senderAgentId: config.agentId,
    recipients: [peerId], createdAt: new Date().toISOString(), payloadCiphertext: payload.ciphertext, payloadNonce: payload.nonce, signature: '',
    ...(peer.channelId ? { channelId: peer.channelId } : {}), ...(config.memberId ? { senderMemberId: config.memberId } : {}), ...(peer.memberId ? { addresseeMemberId: peer.memberId } : {}) };
  envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), config.keys.signing.privateKey);
  const codec = StringCodec(), sub = connection.subscribe('msg.>'); // Observer: never ACK, persist, or create consumers.
  const started = Date.now(), deadline = started + timeoutMs;
  let verified: { msgId: string; text: string } | null = null;
  const listener = (async () => {
    for await (const message of sub) {
      try {
        const reply = JSON.parse(codec.decode(message.data));
        if (!isEnvelopeV1(reply) || reply.senderAgentId !== peerId || reply.conversationId !== conversationId
          || !reply.recipients.includes(config.agentId) || reply.channelId !== envelope.channelId
          || Date.parse(reply.createdAt) < started - 5000 || Date.parse(reply.createdAt) > Date.now() + 5000) continue;
        if (!await verifyEnvelopeSignature(stableEnvelopePayload(reply), reply.signature, peer.signing.publicKey)) continue;
        const plain = await decryptPayload({ ciphertext: reply.payloadCiphertext, nonce: reply.payloadNonce, senderPublicKey: peer.encryption.publicKey }, config.keys.encryption.privateKey);
        if (plain.trim() === `MURMUR-DOCTOR-REPLY ${nonce}`) verified = { msgId: reply.msgId, text: plain };
      } catch { /* Unrelated or untrusted frames are not probe evidence. */ }
    }
  })();
  let db: DatabaseSync | undefined;
  try {
    await connection.flush();
    // Reuse the real daemon outbox path. A publisher-only probe could hide a broken daemon.
    const outbox = new SQLiteDedupeOutboxStore(c.storePath);
    try { await outbox.enqueue(peer.subject, envelope); } finally { outbox.close(); }
    db = new DatabaseSync(c.storePath, { readOnly: true });
    while (Date.now() < deadline) {
      const candidate = verified as { msgId: string; text: string } | null;
      if (candidate) {
        const row = db.prepare("SELECT text FROM local_messages WHERE direction='inbound' AND msg_id=? AND sender=? AND conversation_id=?").get(candidate.msgId, peerId, conversationId);
        if (row?.text === candidate.text) {
          const verifiedAt = new Date().toISOString();
          let proofs: Record<string, unknown> = {};
          try { proofs = await readJson(path.join(c.dataDir, 'pair-proofs.json')); } catch {}
          await writeState(c, path.join(c.dataDir, 'pair-proofs.json'), { ...proofs,
            [peerId]: { peerId, localAgentId: config.agentId, keyFingerprint: pairFingerprint(config, peerId), verifiedAt } });
          return { msgId: envelope.msgId, replyMsgId: candidate.msgId, peerId, verifiedAt };
        }
      }
      await delay(Math.min(50, Math.max(0, deadline - Date.now())));
    }
    throw new Error('roundtrip.timeout');
  } finally { db?.close(); sub.unsubscribe(); await listener; }
}

export async function runDoctor({ context, adapter, peer, timeoutMs = 10000 }: DoctorOptions) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('doctor.invalid-timeout');
  const generatedAt = new Date().toISOString(), stages: Array<Record<string, unknown>> = [];
  let config: AgentConfig | null = null, connection: NatsConnection | undefined;
  let snapshot: Awaited<ReturnType<typeof readStatus>> | undefined;
  let failedStage: string | null = null, worst = 'ok';
  const stage = async (id: string, title: string, fn: () => Promise<{ state?: string; reason?: string; detail: string; fixHint?: string }>) => {
    const start = Date.now();
    if (failedStage) { stages.push({ id, title, state: 'skip', reason: `blocked-by:${failedStage}`, detail: 'Not measured after earlier failure', fixHint: null, elapsedMs: id === 'wake' ? null : 0, measuredAt: null }); return; }
    try {
      const result = await fn(), state = result.state ?? 'ok';
      if (state === 'warn' && worst === 'ok') worst = 'warn';
      stages.push({ id, title, state, detail: result.detail, reason: result.reason ?? null, fixHint: result.fixHint ?? null,
        elapsedMs: id === 'wake' ? null : Date.now() - start, measuredAt: new Date().toISOString() });
    } catch (e) {
      failedStage = id; worst = 'fail';
      stages.push({ id, title, state: 'fail', reason: safeError(e), detail: `${title}: ${safeError(e)}`, fixHint: null,
        elapsedMs: id === 'wake' ? null : Date.now() - start, measuredAt: new Date().toISOString() });
    }
  };
  try {
    await stage('config', 'Configuration', async () => { config = await loadConfig(context); return { detail: 'Identity, keys and peer configuration validated' }; });
    await stage('daemon', 'Daemon and store', async () => {
      snapshot = await readStatus({ context, adapter });
      if (snapshot.service.state !== 'running') throw new Error('daemon.not-running');
      if (!snapshot.service.observedStorePath) throw new Error('daemon.store-unverified');
      return { detail: 'Service PID holds the selected database open' };
    });
    await stage('broker', 'Broker authentication and RTT', async () => {
      try {
        connection = await connect({ ...buildNatsConnectionOptions({ url: config!.natsUrl, token: config!.natsToken }), reconnect: false, waitOnFirstConnect: false, timeout: timeoutMs });
        await connection.rtt();
      } catch (e) { throw new Error((e as { code?: string }).code === 'AUTHORIZATION_VIOLATION' ? 'broker.unauthorized' : 'broker.unreachable'); }
      return { detail: 'Broker accepted authentication and replied' };
    });
    await stage('peers', 'Peer pairing evidence', async () => {
      if (peer && !config!.peers[peer]) throw new Error('peers.unknown');
      if (!Object.keys(config!.peers).length) throw new Error('peers.none');
      const list = snapshot!.peers.list ?? [];
      return list.every(p => p.paired === true) ? { detail: 'Fresh two-way proofs exist for configured peers' }
        : { state: 'warn', reason: 'peers.unmeasured', detail: 'Local keys alone do not prove mutual pairing', fixHint: 'Run murmur doctor --peer <configured-agent-id> --json' };
    });
    await stage('roundtrip', 'Encrypted signed roundtrip', async () => {
      if (!peer) return { state: 'warn', reason: 'roundtrip.peer-required', detail: 'No diagnostic peer selected; no message sent', fixHint: 'Run murmur doctor --peer <configured-agent-id> --json' };
      const proof = await probeRoundtrip(context, config!, peer, connection!, timeoutMs);
      return { detail: `Authenticated reply persisted from ${proof.peerId}` };
    });
    await stage('wake', 'Wake mode and responder', async () => {
      const s = await readStatus({ context, adapter });
      if (s.wake.effective.enabled === null) return { state: 'warn', reason: 'wake.unmeasured', detail: 'No fresh runtime evidence' };
      if (s.wake.effective.needsRestart) return { state: 'warn', reason: 'wake.mode-mismatch', detail: 'Configured and effective wake differ', fixHint: 'Run murmur wake pause --apply or murmur wake resume --apply for the intended mode' };
      if (!s.wake.effective.enabled) return { state: 'warn', reason: 'wake.paused', detail: 'Wake is paused; pending messages remain queued' };
      if (s.wake.config.mode === 'none' || s.wake.config.responder === 'none') return { state: 'warn', reason: 'wake.no-responder', detail: 'No wake responder configured' };
      if (s.wake.faults.lastFault) throw new Error(s.wake.faults.lastFault);
      // A reply is not evidence that a particular UI/session was awakened.
      return { state: 'warn', reason: 'wake.live-proof-required', detail: 'Wake configured; intended live-session receipt requires separate proof' };
    });
  } finally { await connection?.close(); }
  return { schema: 'murmur.doctor/1', generatedAt, agentId: (config as AgentConfig | null)?.agentId ?? null, stages, summary: { worst, failedStage } };
}
