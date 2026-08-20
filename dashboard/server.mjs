#!/usr/bin/env node
/** Authenticated, signature-verifying Murmur observability dashboard. */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { connect, StringCodec } from "nats";
import { buildSecureNatsConnectionOptions } from "@murmurv2/core";
import Database from "better-sqlite3";
import { SECURITY_HEADERS, isAuthorizedHeader, isSameOriginWebSocket, loadDashboardToken } from "./http-security.mjs";
import { authenticateEnvelope } from "./message-security.mjs";
import { validAgentId } from "./render.mjs";

const PORT = Number(process.env.DASHBOARD_PORT) || 4280;
const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const NATS_TOKEN = process.env.NATS_TOKEN;
const NATS_USER = process.env.NATS_USER;
const NATS_PASSWORD = process.env.NATS_PASSWORD;
const NATS_CA_FILE = process.env.NATS_CA_FILE;
const NATS_SERVER_NAME = process.env.NATS_SERVER_NAME;
const DASHBOARD_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(DASHBOARD_DIR, "..", ".data");
const TOKEN_FILE = process.env.DASHBOARD_TOKEN_FILE || path.join(homedir(), ".config", "murmur", "dashboard-token");

let config;
let dashboardToken;
try {
  config = JSON.parse(await readFile(path.join(DATA_DIR, "agent-config.json"), "utf8"));
  dashboardToken = loadDashboardToken(TOKEN_FILE);
} catch (error) {
  console.error(`[dashboard] Refusing to start: ${error.message}`);
  process.exit(1);
}

const agents = [config.agentId, ...Object.keys(config.peers || {})];
if (!agents.every(validAgentId)) {
  console.error("[dashboard] Refusing to start: invalid agent identifier in configuration");
  process.exit(1);
}

const staticFiles = new Map([
  ["/", ["dashboard.html", "text/html; charset=utf-8"]],
  ["/index.html", ["dashboard.html", "text/html; charset=utf-8"]],
  ["/dashboard.css", ["dashboard.css", "text/css; charset=utf-8"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["/render.mjs", ["render.mjs", "text/javascript; charset=utf-8"]],
]);

const write = (res, status, contentType, body, extra = {}) => {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType, ...extra });
  res.end(body);
};

const unauthorized = (res) => write(
  res,
  401,
  "application/json; charset=utf-8",
  JSON.stringify({ error: "authentication required" }),
  { "WWW-Authenticate": 'Basic realm="Murmur dashboard", charset="UTF-8"' },
);

const authorized = (req) => isAuthorizedHeader(req.headers.authorization, dashboardToken);

function loadHistory(limit = 50) {
  try {
    const db = new Database(path.join(DATA_DIR, "murmur.db"), { readonly: true });
    const rows = db.prepare(`
      SELECT conversation_id, msg_id, direction, sender, text, created_at, transport
      FROM local_messages
      ORDER BY rowid DESC
      LIMIT ?
    `).all(limit);
    db.close();
    return rows.reverse();
  } catch (error) {
    console.warn("[dashboard] Cannot load history:", error.message);
    return [];
  }
}

const historyEvent = (row) => {
  const from = validAgentId(row.sender) ? row.sender : "unknown";
  const inferredTo = row.direction === "inbound" ? config.agentId : row.conversation_id?.split(":")?.[1];
  const to = validAgentId(inferredTo) ? inferredTo : "unknown";
  return {
    type: "message",
    from,
    to,
    text: typeof row.text === "string" ? row.text.slice(0, 500) : "",
    ts: typeof row.created_at === "string" ? row.created_at : "",
    msgId: typeof row.msg_id === "string" ? row.msg_id : "",
    encrypted: false,
    authenticated: true,
    direction: row.direction === "inbound" ? "inbound" : "outbound",
    historical: true,
    provenance: "verified-local-store",
  };
};

const httpServer = createServer(async (req, res) => {
  if (!authorized(req)) return unauthorized(res);

  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (staticFiles.has(pathname)) {
    const [filename, contentType] = staticFiles.get(pathname);
    try {
      return write(res, 200, contentType, await readFile(path.join(DASHBOARD_DIR, filename)));
    } catch {
      return write(res, 404, "text/plain; charset=utf-8", "Not found");
    }
  }

  if (pathname === "/api/agents") {
    return write(res, 200, "application/json; charset=utf-8", JSON.stringify({ agents, self: config.agentId }));
  }

  if (pathname === "/api/history") {
    return write(res, 200, "application/json; charset=utf-8", JSON.stringify(loadHistory(100).map(historyEvent)));
  }

  return write(res, 404, "text/plain; charset=utf-8", "Not found");
});

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

httpServer.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname !== "/ws" || !authorized(req) || !isSameOriginWebSocket(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "init", self: config.agentId, agents, ts: new Date().toISOString() }));
  for (const row of loadHistory(50)) ws.send(JSON.stringify(historyEvent(row)));
  ws.on("close", () => clients.delete(ws));
});

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === 1) ws.send(json);
}

const sc = StringCodec();
let authenticatedCount = 0;
let rejectedCount = 0;
const startTime = Date.now();

try {
  // Same secure-transport rules as the daemon: TLS is required off loopback, and the
  // broker can demand a per-agent user/password instead of a shared token. Connecting
  // with `{ servers, token }` only — as this dashboard did — meant it was the one
  // component left behind by a broker cutover, failing with what looks like a network
  // fault rather than an auth one.
  const nc = await connect(
    buildSecureNatsConnectionOptions({
      url: NATS_URL,
      token: NATS_TOKEN,
      user: NATS_USER,
      password: NATS_PASSWORD,
      tls: NATS_CA_FILE || NATS_SERVER_NAME
        ? { caFile: NATS_CA_FILE, serverName: NATS_SERVER_NAME }
        : undefined,
    }),
  );
  console.log(`[dashboard] NATS connected: ${NATS_URL}`);
  const sub = nc.subscribe("msg.>");

  (async () => {
    for await (const message of sub) {
      const result = await authenticateEnvelope(sc.decode(message.data), message.subject, config);
      if (result.accepted) {
        authenticatedCount += 1;
        broadcast(result.event);
      } else {
        rejectedCount += 1;
        console.warn(`[dashboard] Rejected broker frame: ${result.reason}`);
      }
    }
  })();

  setInterval(() => broadcast({
    type: "stats",
    totalMessages: authenticatedCount,
    rejectedMessages: rejectedCount,
    activeClients: clients.size,
    uptimeMs: Date.now() - startTime,
    agents,
    ts: new Date().toISOString(),
  }), 5000);
} catch (error) {
  console.error(`[dashboard] NATS failed: ${error.message}`);
}

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[dashboard] Authenticated dashboard listening on http://127.0.0.1:${PORT}`);
});
