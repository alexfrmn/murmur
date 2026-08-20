#!/usr/bin/env node
import path from "node:path";
import { readPrivateJson, writePrivateJson } from "./secure-state.mjs";

const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");

const readConfig = async () => {
  try {
    return await readPrivateJson(configPath);
  } catch (err) {
    console.error(`[openclaw-init] Failed to read ${configPath}: ${err.message}`);
    process.exit(1);
  }
};

const run = async () => {
  const cfg = await readConfig();
  if (!cfg.notify) cfg.notify = {};

  const sessionId = process.env.MURMUR_OPENCLAW_SESSION_ID || "";
  const sessionLabel = process.env.MURMUR_OPENCLAW_SESSION_LABEL || "";
  const sessionKey = process.env.MURMUR_OPENCLAW_SESSION_KEY || "";
  const to = process.env.MURMUR_OPENCLAW_TO || "";
  const routeChannel = process.env.MURMUR_OPENCLAW_CHANNEL || "telegram";
  const agent = process.env.MURMUR_OPENCLAW_AGENT || "";
  const helperScript = process.env.MURMUR_OPENCLAW_HELPER_SCRIPT || "scripts/on-receive-openclaw.mjs";
  const command = process.env.MURMUR_OPENCLAW_COMMAND || "";
  const gatewayUrl = process.env.MURMUR_OPENCLAW_GATEWAY_URL || "";
  const gatewayToken = process.env.MURMUR_OPENCLAW_GATEWAY_TOKEN || "";

  if (!sessionId && !to && !command) {
    console.error("[openclaw-init] Set MURMUR_OPENCLAW_SESSION_ID or MURMUR_OPENCLAW_TO (or MURMUR_OPENCLAW_COMMAND)");
    process.exit(1);
  }

  cfg.notify.openclaw = {
    enabled: true,
    channel: "openclaw-main",
    routeChannel,
    ...(agent ? { agent } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionLabel ? { sessionLabel } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(to ? { to } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(gatewayToken ? { gatewayToken } : {}),
    ...(command ? { command } : { helperScript }),
  };

  await writePrivateJson(configPath, cfg);
  console.log(`[openclaw-init] Updated ${configPath}`);
  console.log("[openclaw-init] notify.openclaw configured", {
    channel: cfg.notify.openclaw.channel,
    routeChannel: cfg.notify.openclaw.routeChannel,
    hasAgent: Boolean(cfg.notify.openclaw.agent),
    hasSessionId: Boolean(cfg.notify.openclaw.sessionId),
    hasSessionKey: Boolean(cfg.notify.openclaw.sessionKey),
    hasTarget: Boolean(cfg.notify.openclaw.to),
    hasGatewayUrl: Boolean(cfg.notify.openclaw.gatewayUrl),
    hasGatewayToken: Boolean(cfg.notify.openclaw.gatewayToken),
    mode: cfg.notify.openclaw.command ? "command" : "helper-script",
  });
};

run().catch((err) => {
  console.error("[openclaw-init] Failed:", err.message);
  process.exit(1);
});
