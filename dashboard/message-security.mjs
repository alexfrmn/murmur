import { isEnvelopeV1, stableEnvelopePayload } from "../packages/core/dist/src/index.js";
import { decryptPayload, verifyEnvelopeSignature } from "../packages/security/dist/src/index.js";
import { validAgentId } from "./render.mjs";

const rejected = (reason) => ({ accepted: false, reason });

export async function authenticateEnvelope(raw, subject, config) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return rejected("invalid-json");
  }

  if (!isEnvelopeV1(envelope)) return rejected("unsigned-or-invalid-envelope");
  if (!validAgentId(envelope.senderAgentId)) return rejected("invalid-sender-id");
  if (typeof subject !== "string" || !subject.startsWith("msg.")) return rejected("invalid-subject");

  const subjectRecipient = subject.slice(4);
  if (!validAgentId(subjectRecipient) || !envelope.recipients.includes(subjectRecipient)) {
    return rejected("recipient-subject-mismatch");
  }

  const outbound = envelope.senderAgentId === config.agentId;
  if (!outbound && subjectRecipient !== config.agentId) return rejected("not-local-traffic");

  const peerId = outbound ? subjectRecipient : envelope.senderAgentId;
  const peer = config.peers?.[peerId];
  if (!peer?.signing?.publicKey || !peer?.encryption?.publicKey) return rejected("unknown-peer");

  const signingPublicKey = outbound ? config.keys?.signing?.publicKey : peer.signing.publicKey;
  if (typeof signingPublicKey !== "string") return rejected("missing-signing-key");

  try {
    const valid = await verifyEnvelopeSignature(
      stableEnvelopePayload(envelope),
      envelope.signature,
      signingPublicKey,
    );
    if (!valid) return rejected("signature-invalid");

    const plaintext = await decryptPayload(
      {
        ciphertext: envelope.payloadCiphertext,
        nonce: envelope.payloadNonce,
        senderPublicKey: peer.encryption.publicKey,
      },
      config.keys.encryption.privateKey,
    );

    return {
      accepted: true,
      event: {
        type: "message",
        from: envelope.senderAgentId,
        to: subjectRecipient,
        text: plaintext.slice(0, 1000),
        ts: envelope.createdAt,
        msgId: envelope.msgId,
        encrypted: true,
        authenticated: true,
        direction: outbound ? "outbound" : "inbound",
      },
    };
  } catch {
    return rejected("verification-or-decryption-failed");
  }
}
