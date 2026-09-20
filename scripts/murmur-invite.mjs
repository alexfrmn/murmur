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

// The address is parsed, not pattern-matched. A regex over the raw string reads
// what the string looks like; the client reads what the address means, and the
// two differ on leading whitespace, on a credential that is not at the start,
// and on anything malformed. Review found exactly that: two spaces in front of
// the URL defeated an anchored regex and the password was printed in the clear.
//
// The accepted shape is the one packages/setup/src/config.ts enforces: nats: or
// tls:, no query, no fragment. A credential in the URL is not rejected here —
// legacy profiles have them and refusing would only push people to read the raw
// file — but it is named and masked. Anything else stops before any output.
function inspectBrokerUrl(raw) {
  const text = String(raw ?? "").trim();
  let url;
  try { url = new URL(text); } catch { return { fatal: "not a valid URL" }; }
  if (!["nats:", "tls:"].includes(url.protocol)) return { fatal: `unsupported scheme ${url.protocol}` };
  if (url.search) return { fatal: "query string in the broker URL" };
  if (url.hash) return { fatal: "fragment in the broker URL" };
  const carries = !!(url.username || url.password);
  const masked = new URL(text);
  if (carries) { masked.username = "***"; masked.password = ""; }
  return { carries, masked: masked.href };
}

const address = inspectBrokerUrl(config.natsUrl);
if (address.fatal) {
  // Refuse before printing anything: the blob would carry this address onward,
  // and an address we cannot read is one we cannot promise to have masked.
  console.error(`[invite] Broker URL in ${configPath} is not usable: ${address.fatal}.`);
  console.error("[invite] Fix the profile, or create the invite with: murmur invite --out FILE");
  process.exit(1);
}
const carriesCredential = !!config.natsToken || address.carries;

// The broker URL is already inside the blob. Printing it again only adds a copy
// to the shell history, and with a credential in it that copy is the password.
const safeUrl = address.masked;

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
