// Machine-only roundtrip protocol. Call only after peer signature verification,
// decryption and channel authorization. This proves transport, never AI wake.
import { createHash } from "node:crypto";
import { resolveMessageSubject, stableEnvelopePayload } from "@murmurv2/core";
import { decryptPayload, encryptPayload, signEnvelope } from "@murmurv2/security";

const PREFIX = "murmur:doctor:";
const CONVERSATION = /^murmur:doctor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST = /^Murmur diagnostic roundtrip\. Reply in this same conversation with exactly this line: MURMUR-DOCTOR-REPLY ([0-9a-f]{48})$/;
const REPLY = /^MURMUR-DOCTOR-REPLY ([0-9a-f]{48})$/;
const WINDOW_MS = 60_000;

export function classifyVerifiedDoctorMessage(config, envelope, text, now = Date.now()) {
  if (!envelope.conversationId.startsWith(PREFIX)) return null;
  const invalid = { kind: "ignored" };
  const peer = config.peers[envelope.senderAgentId];
  const at = Date.parse(envelope.createdAt);
  if (!peer || envelope.senderAgentId === config.agentId
      || !CONVERSATION.test(envelope.conversationId) || envelope.conversationId.includes("\n")
      || envelope.recipients.length !== 1 || envelope.recipients[0] !== config.agentId
      || !Number.isFinite(at) || at < now - WINDOW_MS || at > now + 5000
      || envelope.channelId !== peer.channelId
      || envelope.senderMemberId !== peer.memberId
      || envelope.addresseeMemberId !== config.memberId) return invalid;
  const request = REQUEST.exec(text);
  if (request?.[0] === text) return { kind: "request", nonce: request[1] };
  const reply = REPLY.exec(text);
  return reply?.[0] === text ? { kind: "reply" } : invalid;
}

export function doctorReplyId(agentId, envelope) {
  const hex = createHash("sha256").update(JSON.stringify([
    "murmur-doctor-reply/1", agentId, envelope.senderAgentId, envelope.msgId,
  ])).digest("hex");
  // Stable UUID: a redelivery after a crash can finish enqueueing, but cannot
  // resurrect a settled reply or create another message.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createDoctorResponder({ config, outbox, messages, now = Date.now }) {
  let recent = [];
  const inFlight = new Map();
  const reply = async (request, nonce) => {
    const msgId = doctorReplyId(config.agentId, request);
    const existing = await outbox.getOutboxRecord(msgId);
    let envelope = existing?.envelope;
    const text = `MURMUR-DOCTOR-REPLY ${nonce}`;
    const peer = config.peers[request.senderAgentId];
    if (envelope) {
      const storedText = await decryptPayload({ ciphertext: envelope.payloadCiphertext,
        nonce: envelope.payloadNonce, senderPublicKey: peer.encryption.publicKey }, config.keys.encryption.privateKey);
      if (envelope.conversationId !== request.conversationId || storedText !== text) {
        throw new Error("doctor.request-conflict");
      }
    }
    if (!envelope) {
      const at = now();
      recent = recent.filter(entry => entry.at > at - WINDOW_MS);
      // At most 60 retained entries: no unbounded peer map. Diagnostic floods
      // from a configured peer cannot create unbounded response work.
      if (recent.length >= 60 || recent.filter(entry => entry.peer === request.senderAgentId).length >= 6) {
        return { state: "rate-limited" };
      }
      recent.push({ at, peer: request.senderAgentId });
      const encrypted = await encryptPayload(text, peer.encryption.publicKey, config.keys.encryption.privateKey);
      envelope = {
        schemaVersion: "1.0", msgId, conversationId: request.conversationId,
        senderAgentId: config.agentId, recipients: [request.senderAgentId], createdAt: new Date(at).toISOString(),
        payloadCiphertext: encrypted.ciphertext, payloadNonce: encrypted.nonce, signature: "",
        ...(peer.channelId ? { channelId: peer.channelId } : {}),
        ...(config.memberId ? { senderMemberId: config.memberId } : {}),
        ...(peer.memberId ? { addresseeMemberId: peer.memberId } : {}),
      };
      envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), config.keys.signing.privateKey);
      await outbox.enqueue(resolveMessageSubject(peer, peer.channelId), envelope);
    }
    // Repair the history half if a crash followed the durable outbox enqueue.
    await messages.append({
      msgId, conversationId: envelope.conversationId, direction: "outbound", sender: config.agentId,
      text, createdAt: envelope.createdAt, transport: "nats", channelId: envelope.channelId,
      senderMemberId: envelope.senderMemberId, addresseeMemberId: envelope.addresseeMemberId,
    });
    return { state: existing ? "already-queued" : "queued", msgId };
  };
  return {
    respond(envelope, plaintext) {
      const diagnostic = classifyVerifiedDoctorMessage(config, envelope, plaintext, now());
      if (diagnostic?.kind !== "request") return Promise.resolve({ state: "ignored" });
      const id = doctorReplyId(config.agentId, envelope);
      if (inFlight.has(id)) return inFlight.get(id);
      const pending = reply(envelope, diagnostic.nonce).finally(() => inFlight.delete(id));
      inFlight.set(id, pending);
      return pending;
    },
  };
}
