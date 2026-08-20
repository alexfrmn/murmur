#!/usr/bin/env node
/**
 * agent-config-init.mjs — One-time agent identity setup.
 * Generates X25519 (encryption) + Ed25519 (signing) keypairs,
 * writes .data/agent-config.json.
 *
 * Usage: node scripts/agent-config-init.mjs
 * Env overrides: AGENT_ID, NATS_URL, NATS_TOKEN, DATA_DIR
 */
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { createKeyPair, createSigningKeyPair, getCryptoProvider } from "@murmurv2/security";
import { readPrivateJson, writePrivateJson } from "./secure-state.mjs";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = async (question, defaultValue) => {
  const answer = await rl.question(`${question} [${defaultValue}]: `);
  return answer.trim() || defaultValue;
};

const run = async () => {
  const dataDir = process.env.DATA_DIR || ".data";
  const configPath = path.join(dataDir, "agent-config.json");

  // Check if config already exists
  try {
    const parsed = await readPrivateJson(configPath);
    console.log(`[init] Config already exists at ${configPath} (agentId: ${parsed.agentId})`);
    const overwrite = await ask("Overwrite? (yes/no)", "no");
    if (overwrite !== "yes") {
      console.log("[init] Aborted.");
      rl.close();
      return;
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  const agentId = process.env.AGENT_ID || await ask("Agent ID", "my-agent");
  const natsUrl = process.env.NATS_URL || await ask("NATS URL", "nats://127.0.0.1:4222");
  const natsToken = process.env.NATS_TOKEN || await ask("NATS token", "");

  console.log("[init] Generating keypairs...");
  const encryption = await createKeyPair();
  const signing = await createSigningKeyPair();

  const config = {
    agentId,
    natsUrl,
    natsToken: natsToken || undefined,
    subject: `msg.${agentId}`,
    dataDir,
    cryptoProvider: getCryptoProvider().name,
    keys: { encryption, signing },
    ackSecurity: {
      emitSigned: true,
      requireSigned: false,
      maxAgeMs: 300000,
    },
    peers: {},
  };

  await writePrivateJson(configPath, config);

  console.log(`[init] Config written to ${configPath}`);
  console.log("");
  console.log("=== Share these public keys with peers ===");
  console.log(JSON.stringify({
    agentId,
    subject: config.subject,
    encryption: { publicKey: encryption.publicKey },
    signing: { publicKey: signing.publicKey },
  }, null, 2));
  console.log("");
  console.log("To add a peer, edit the 'peers' section in agent-config.json:");
  console.log(`  "peers": { "other-agent": { "encryption": { "publicKey": "..." }, "signing": { "publicKey": "..." }, "subject": "msg.other-agent" } }`);

  rl.close();
};

run().catch((err) => {
  console.error("[init] Failed:", err.message);
  process.exitCode = 1;
  rl.close();
});
