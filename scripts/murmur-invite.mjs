#!/usr/bin/env node
/**
 * murmur-invite.mjs — Generate invite blob for a remote peer.
 * The invite contains NATS connection info + your public keys.
 * When the profile holds a broker credential, the blob carries it: the file is
 * then a password and belongs only in a channel you would trust with one.
 *
 * Usage: node scripts/murmur-invite.mjs
 * Env: DATA_DIR (default: .data)
 */
import path from "node:path";
import { readPrivateJson } from "./secure-state.mjs";

const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");

let config;
try {
  config = await readPrivateJson(configPath);
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
  console.error("[invite] No agent config found. Run first: node scripts/agent-config-init.mjs");
  process.exit(1);
}

const invite = {
  v: 1,
  type: "invite",
  agentId: config.agentId,
  natsUrl: config.natsUrl,
  natsToken: config.natsToken || undefined,
  subject: config.subject,
  encryption: { publicKey: config.keys.encryption.publicKey },
  signing: { publicKey: config.keys.signing.publicKey },
};

const blob = "MURMUR:" + Buffer.from(JSON.stringify(invite)).toString("base64");

// A credential can reach the blob two ways: as natsToken, or as userinfo inside
// the URL. Both make this output a password, so both must reach the warning.
const urlCarriesCredential = /^[a-z]+:\/\/[^/@]*@/i.test(config.natsUrl || "");
const carriesCredential = !!config.natsToken || urlCarriesCredential;

// The broker URL is already inside the blob. Printing it again only adds a copy
// to the shell history, and with userinfo in it that copy is the credential.
const safeUrl = String(config.natsUrl || "").replace(/^([a-z]+:\/\/)[^/@]*@/i, "$1***@");

console.log("");
console.log("=== Send this invite to your peer ===");
console.log("");
if (carriesCredential) {
  console.log("This blob carries the broker address and its credential.");
  console.log("Treat it like a password: send it only through a channel you would trust with one.");
} else {
  console.log("This blob carries your identity and the broker address.");
  console.log("Send it through a channel you trust.");
}
console.log("Importing it does not prove pairing — require a message back.");
console.log("");
console.log(blob);
console.log("");
console.log(`Your agent: ${config.agentId}`);
console.log(`NATS: ${safeUrl}`);
console.log("");
console.log("Peer should run: node scripts/murmur-join.mjs MURMUR:...");
console.log("Then send you back the MURMUR-REPLY:... blob.");
console.log("You finish with: node scripts/murmur-add-peer.mjs MURMUR-REPLY:...");
