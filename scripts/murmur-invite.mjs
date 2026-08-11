#!/usr/bin/env node
/**
 * murmur-invite.mjs — Generate invite blob for a remote peer.
 * The invite contains NATS connection info + your public keys.
 * Send the blob to your friend via any messenger.
 *
 * Usage: node scripts/murmur-invite.mjs
 * Env: DATA_DIR (default: .data)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");

let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch {
  console.error("[invite] No agent config found. Run first: node scripts/agent-config-init.mjs");
  process.exit(1);
}

const inviteNatsUser = process.env.MURMUR_INVITE_NATS_USER || undefined;
const inviteNatsPassword = process.env.MURMUR_INVITE_NATS_PASSWORD || undefined;
const invite = {
  v: 1,
  type: "invite",
  agentId: config.agentId,
  natsUrl: config.natsUrl,
  natsToken: inviteNatsUser
    ? undefined
    : process.env.MURMUR_INVITE_NATS_TOKEN || config.natsToken || undefined,
  natsUser: inviteNatsUser,
  natsPassword: inviteNatsPassword,
  natsCaPem: config.natsTls?.caFile
    ? await readFile(config.natsTls.caFile, "utf8")
    : undefined,
  natsServerName: config.natsTls?.serverName || undefined,
  subject: config.subject,
  encryption: { publicKey: config.keys.encryption.publicKey },
  signing: { publicKey: config.keys.signing.publicKey },
};

if (config.natsUser && (!invite.natsUser || !invite.natsPassword)) {
  console.error(
    "[invite] Per-peer broker auth requires dedicated MURMUR_INVITE_NATS_USER and "
      + "MURMUR_INVITE_NATS_PASSWORD values. Refusing to share this agent's credential.",
  );
  process.exit(1);
}
if (!!invite.natsUser !== !!invite.natsPassword) {
  console.error("[invite] Both MURMUR_INVITE_NATS_USER and MURMUR_INVITE_NATS_PASSWORD are required.");
  process.exit(1);
}

const blob = "MURMUR:" + Buffer.from(JSON.stringify(invite)).toString("base64");

console.log("");
console.log("=== Send this invite to your peer ===");
console.log("");
console.log(blob);
console.log("");
console.log(`Your agent: ${config.agentId}`);
console.log(`NATS: ${config.natsUrl}`);
console.log("");
console.log("Peer should run: node scripts/murmur-join.mjs MURMUR:...");
console.log("Then send you back the MURMUR-REPLY:... blob.");
console.log("You finish with: node scripts/murmur-add-peer.mjs MURMUR-REPLY:...");
