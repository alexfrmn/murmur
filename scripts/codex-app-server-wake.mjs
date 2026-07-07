import WebSocket from "ws";
import { buildChannelThreadStartBinding } from "@murmurv2/core";
import { execFile } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10000;
const INITIALIZE_TIMEOUT_MS = 10000;
const DEFAULT_TURN_COMPLETION_TIMEOUT_MS = 180000;
const SESSION_LOG_POLL_INTERVAL_MS = 1000;
const SESSION_LOG_TAIL_BYTES = 8 * 1024 * 1024;

const shellQuote = (value) => `'${String(value ?? "").replace(/'/g, "'\\''")}'`;

const buildReplyHint = (payload, peer = {}) => {
  if (peer?.relayFinalToMurmur === true) {
    return [
      "",
      "[MURMUR REPLY RELAY]",
      "If this Murmur message asks for a reply, put only the reply body in your final answer.",
      "Do not call tools to send Murmur yourself; the local daemon will relay your final answer back through Murmur.",
    ];
  }

  const murmurRoot = peer?.murmurRoot;
  const dataDir = peer?.dataDir;
  const storePath = peer?.storePath;
  if (!murmurRoot || !dataDir || !storePath || !payload?.from) return [];

  const conv = payload.conversationId || "";
  const command = [
    `cd ${shellQuote(murmurRoot)}`,
    `DATA_DIR=${shellQuote(dataDir)}`,
    `MURMUR_STORE_PATH=${shellQuote(storePath)}`,
    "node scripts/murmur-shell-send.mjs",
    `--to ${shellQuote(payload.from)}`,
    `--conv ${shellQuote(conv)}`,
    "--text '<your one-line reply>'",
  ].join(" ");

  return [
    "",
    "[LOCAL REPLY PATH]",
    "If this Murmur message asks for a reply, use the local command below.",
    "Do not SSH back into this Mac and do not use the default .data directory.",
    command,
  ];
};

export const buildCodexTurnText = (payload, peer = {}) => {
  const lines = [
    "[MURMUR WAKE]",
    `from=${payload.from || "unknown"}`,
    `conversationId=${payload.conversationId || ""}`,
    `msgId=${payload.msgId || ""}`,
    ...buildReplyHint(payload, peer),
    "",
    payload.text || "",
  ];
  return lines.join("\n");
};

export const buildTurnStartRequest = ({ id = 1, threadId, text, metadata = {} }) => ({
  id,
  method: "turn/start",
  params: {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    responsesapiClientMetadata: metadata,
  },
});

const readSessionLogTail = (sessionPath) => {
  const { size } = statSync(sessionPath);
  const length = Math.min(size, SESSION_LOG_TAIL_BYTES);
  if (length <= 0) return "";
  const fd = openSync(sessionPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

export const readFinalAnswerFromSessionLog = (sessionPath, turnId) => {
  if (!sessionPath || !turnId) return "";
  let data = "";
  try {
    data = readSessionLogTail(sessionPath);
  } catch {
    return "";
  }

  const lines = data.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(turnId)) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry?.payload || {};
    if (entry.type === "event_msg" && payload.type === "task_complete" && payload.turn_id === turnId) {
      return typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
    }

    const metadataTurnId = payload?.internal_chat_message_metadata_passthrough?.turn_id;
    if (
      payload.type === "message"
      && payload.role === "assistant"
      && payload.phase === "final_answer"
      && metadataTurnId === turnId
      && Array.isArray(payload.content)
    ) {
      return payload.content.map((part) => part?.text || "").join("\n").trim();
    }
  }
  return "";
};

export const buildThreadStartParams = (binding = null) => ({
  model: binding?.model ?? null,
  modelProvider: null,
  cwd: null,
  runtimeWorkspaceRoots: null,
  approvalPolicy: null,
  approvalsReviewer: null,
  sandbox: null,
  permissions: null,
  config: null,
  serviceName: null,
  baseInstructions: binding?.baseInstructions ?? null,
  developerInstructions: null,
  personality: binding?.personality ?? null,
  ephemeral: false,
  sessionStartSource: null,
  threadSource: null,
  environments: null,
  dynamicTools: null,
  selectedCapabilityRoots: null,
  mockExperimentalField: null,
});

const buildInitializeRequest = (id) => ({
  id,
  method: "initialize",
  params: {
    clientInfo: {
      name: "murmur-codex-app-server-wake",
      title: "Murmur Codex App-Server Wake",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: [
        "command/exec/outputDelta",
        "item/agentMessage/delta",
        "item/plan/delta",
        "item/fileChange/outputDelta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
      ],
    },
  },
});

export class CodexAppServerClient {
  constructor({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, WebSocketImpl = WebSocket } = {}) {
    if (!socketPath) throw new Error("codex-app-server-socket-missing");
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 1;
  }

  request(method, params) {
    const id = this.nextId++;
    const request = { id, method, params };
    return this.send(request, id);
  }

  send(request, expectedId = request.id) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let initialized = false;
      const initId = `init-${this.nextId++}`;
      const url = `ws+unix://${this.socketPath}:/`;
      const socket = new this.WebSocketImpl(url, {
        perMessageDeflate: false,
        handshakeTimeout: Math.min(this.timeoutMs, INITIALIZE_TIMEOUT_MS),
      });
      const timer = setTimeout(() => {
        finish(new Error(`codex-app-server-timeout:${this.socketPath}`));
      }, this.timeoutMs);

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore close races; the request already has a terminal result.
        }
        if (err) reject(err);
        else resolve(result);
      };

      const sendJson = (message) => socket.send(JSON.stringify(message));

      socket.on("open", () => sendJson(buildInitializeRequest(initId)));
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }

        if (message.id === initId) {
          if (message.error) {
            finish(new Error(`codex-app-server-initialize-error:${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          initialized = true;
          sendJson({ method: "initialized" });
          sendJson(request);
          return;
        }

        if (message.id !== expectedId) return;
        if (message.error) {
          finish(new Error(`codex-app-server-error:${message.error.message || JSON.stringify(message.error)}`));
        } else {
          finish(null, message.result);
        }
      });
      socket.on("error", (err) => {
        finish(new Error(`codex-app-server-connect-failed:${this.socketPath}:${err.message}`));
      });
      socket.on("close", () => {
        if (!settled) finish(new Error(`codex-app-server-closed-before-response:${this.socketPath}:${initialized ? "after-initialize" : "before-initialize"}`));
      });
    });
  }

  startTurnAndWaitForFinal(params, {
    completionTimeoutMs = DEFAULT_TURN_COMPLETION_TIMEOUT_MS,
    sessionPath = null,
  } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let initialized = false;
      let turnId = null;
      let startResult = null;
      let finalText = "";
      const requestId = this.nextId++;
      const initId = `init-${this.nextId++}`;
      const url = `ws+unix://${this.socketPath}:/`;
      const socket = new this.WebSocketImpl(url, {
        perMessageDeflate: false,
        handshakeTimeout: Math.min(this.timeoutMs, INITIALIZE_TIMEOUT_MS),
      });
      const timer = setTimeout(() => {
        finish(new Error(`codex-app-server-turn-completion-timeout:${this.socketPath}:${turnId || "unknown"}`));
      }, completionTimeoutMs);
      const sessionLogTimer = setInterval(() => {
        if (settled || !sessionPath || !turnId) return;
        const text = readFinalAnswerFromSessionLog(sessionPath, turnId);
        if (!text) return;
        finalText = finalText || text;
        finish(null, { ...startResult, finalText, turnId, source: "session-log" });
      }, SESSION_LOG_POLL_INTERVAL_MS);

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(sessionLogTimer);
        try {
          socket.close();
        } catch {
          // Ignore close races; the request already has a terminal result.
        }
        if (err) reject(err);
        else resolve(result);
      };

      const sendJson = (message) => socket.send(JSON.stringify(message));
      const declineServerRequest = (message) => {
        if (message.id === undefined || typeof message.method !== "string") return false;
        if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
          sendJson({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
          return true;
        }
        if (message.method === "item/permissions/requestApproval") {
          sendJson({ jsonrpc: "2.0", id: message.id, result: { permissions: { id: ":workspace", extends: null }, scope: "turn" } });
          return true;
        }
        return false;
      };

      socket.on("open", () => {
        sendJson({
          ...buildInitializeRequest(initId),
          params: {
            ...buildInitializeRequest(initId).params,
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              optOutNotificationMethods: [
                "command/exec/outputDelta",
                "item/plan/delta",
                "item/fileChange/outputDelta",
                "item/reasoning/summaryTextDelta",
                "item/reasoning/textDelta",
              ],
            },
          },
        });
      });

      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }

        if (message.id === initId) {
          if (message.error) {
            finish(new Error(`codex-app-server-initialize-error:${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          initialized = true;
          sendJson({ method: "initialized" });
          sendJson({ id: requestId, method: "turn/start", params });
          return;
        }

        if (declineServerRequest(message)) return;

        if (message.id === requestId) {
          if (message.error) {
            finish(new Error(`codex-app-server-error:${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          startResult = message.result;
          turnId = message.result?.turn?.id || turnId;
          return;
        }

        if (message.method === "turn/started" && message.params?.turn?.id) {
          turnId = turnId || message.params.turn.id;
          return;
        }

        if (message.method === "item/completed" && message.params?.turnId) {
          turnId = turnId || message.params.turnId;
          if (message.params.turnId !== turnId) return;
          const item = message.params.item;
          if (item?.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
            finalText = item.text;
            finish(null, { ...startResult, finalText, turnId, source: "app-server-final-item" });
          }
          return;
        }

        if (message.method === "turn/completed" && message.params?.turn?.id) {
          turnId = turnId || message.params.turn.id;
          if (message.params.turn.id !== turnId) return;
          finish(null, { ...startResult, finalText, turnId, source: "app-server-events" });
        }
      });
      socket.on("error", (err) => {
        finish(new Error(`codex-app-server-connect-failed:${this.socketPath}:${err.message}`));
      });
      socket.on("close", () => {
        if (!settled) finish(new Error(`codex-app-server-closed-before-response:${this.socketPath}:${initialized ? "after-initialize" : "before-initialize"}`));
      });
    });
  }
}

const sendRelayReply = (peer = {}, payload = {}, finalText = "") => new Promise((resolve, reject) => {
  const text = String(finalText || "").trim();
  if (!peer.relayFinalToMurmur || !text) {
    resolve(null);
    return;
  }
  if (!peer.murmurRoot || !peer.dataDir || !peer.storePath || !payload.from || !payload.conversationId) {
    reject(new Error("murmur-reply-relay-config-missing"));
    return;
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "murmur-reply-relay."));
  const replyFile = path.join(workdir, "reply.txt");
  writeFileSync(replyFile, text, { mode: 0o600 });
  const script = path.join(peer.murmurRoot, "scripts", "murmur-shell-send.mjs");
  execFile(
    process.execPath,
    [script, "--to", payload.from, "--conv", payload.conversationId, "--text-file", replyFile],
    {
      cwd: peer.murmurRoot,
      env: {
        ...process.env,
        DATA_DIR: peer.dataDir,
        MURMUR_STORE_PATH: peer.storePath,
      },
      timeout: 30000,
    },
    (err, stdout, stderr) => {
      rmSync(workdir, { recursive: true, force: true });
      if (err) {
        const detail = [stderr, stdout, err.message].filter(Boolean).join("\n").slice(0, 1200);
        reject(new Error(detail || "murmur-reply-relay-failed"));
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(String(stdout || "").trim());
      } catch {
        parsed = { stdout: String(stdout || "").trim() };
      }
      resolve(parsed);
    },
  );
});

const pickSingleOpenChannel = (channels) => {
  const open = (channels || []).filter((channel) => !channel.closedAt);
  return open.length === 1 ? open[0] : null;
};

export const createChannelThreadStartBindingResolver = ({ rosterStore, agentId, baseInstructionsResolver = null, log = () => {} } = {}) => {
  if (!rosterStore) return null;
  return async (payload, peer = {}) => {
    const channelId = payload?.channelId || peer.channelId || pickSingleOpenChannel(rosterStore.listChannelsForConversation(payload?.conversationId || ""))?.channelId;
    if (!channelId) return null;

    const memberId = payload?.addresseeMemberId || peer.memberId;
    const effectiveAgentId = agentId || peer.agentId;
    const member = memberId
      ? rosterStore.getChannelMember(channelId, memberId)
      : effectiveAgentId
        ? rosterStore.findActiveChannelMemberForAgent(channelId, effectiveAgentId)
        : null;
    if (!member || member.leftAt) return null;

    const baseInstructions = typeof baseInstructionsResolver === "function"
      ? await baseInstructionsResolver(member, payload, peer)
      : peer.baseInstructions ?? null;
    const binding = buildChannelThreadStartBinding({ member, baseInstructions });
    log("info", "Codex app-server channel binding resolved", {
      msgId: payload?.msgId,
      channelId: member.channelId,
      memberId: member.memberId,
      agentId: member.agentId,
      personaId: member.personaId ?? null,
      model: member.model ?? null,
      hasBaseInstructions: !!baseInstructions,
    });
    return binding;
  };
};

export const createCodexAppServerInjector = ({ Client = CodexAppServerClient, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, resolveThreadStartBinding = null } = {}) => {
  return async (payload, peer) => {
    const socketPath = peer?.socketPath || peer?.target;
    if (!socketPath) throw new Error(`codex-app-server-socket-missing:${payload.from}`);

    const client = new Client({ socketPath, timeoutMs });
    const text = buildCodexTurnText(payload, peer);
    const threadStartBinding = peer?.threadStartBinding ?? (resolveThreadStartBinding ? await resolveThreadStartBinding(payload, peer) : null);
    const bindingMetadata = threadStartBinding?.metadata ?? {};
    const shouldResumeThread = peer?.resume === true || (peer?.resume !== false && peer?.relayFinalToMurmur === true);
    let threadPath = null;
    const resumeThread = async (threadId) => {
      if (!threadId || peer?.resume === false) return;
      try {
        const resumed = await client.request("thread/resume", {
          threadId,
          cwd: peer?.cwd ?? null,
          model: peer?.model ?? null,
        });
        threadPath = resumed?.thread?.path || threadPath;
        log("info", "Codex app-server wake thread resumed", { msgId: payload.msgId, threadId, socketPath });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        log("warn", "Codex app-server wake thread resume failed", { msgId: payload.msgId, threadId, socketPath, error: e.message });
      }
    };
    const turnParams = (threadId) => ({
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(peer?.model ? { model: peer.model } : {}),
      responsesapiClientMetadata: {
        murmur_msg_id: payload.msgId || "",
        murmur_conversation_id: payload.conversationId || "",
        murmur_from: payload.from || "",
        ...bindingMetadata,
      },
    });
    const startTurn = async (threadId) => {
      if (peer?.relayFinalToMurmur === true) {
        const result = await client.startTurnAndWaitForFinal(turnParams(threadId), {
          completionTimeoutMs: Number(peer?.replyTimeoutMs) || DEFAULT_TURN_COMPLETION_TIMEOUT_MS,
          sessionPath: threadPath,
        });
        const relay = await sendRelayReply(peer, payload, result?.finalText || "");
        log("info", "Codex app-server wake final relayed", {
          msgId: payload.msgId,
          threadId,
          socketPath,
          turnId: result?.turnId,
          source: result?.source ?? null,
          replyMsgId: relay?.msgId ?? null,
          finalTextLen: String(result?.finalText || "").length,
        });
        return result;
      }
      return client.request("turn/start", turnParams(threadId));
    };

    let threadId = peer?.threadId;
    if (!threadId) {
      const started = await client.request("thread/start", buildThreadStartParams(threadStartBinding));
      threadId = started?.thread?.id;
      if (!threadId) throw new Error(`codex-app-server-thread-start-missing:${payload.from}`);
      peer.threadId = threadId;
      log("info", "Codex app-server wake thread seeded", { msgId: payload.msgId, threadId, socketPath });
    }

    let result;
    try {
      if (shouldResumeThread) await resumeThread(threadId);
      result = await startTurn(threadId);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!e.message.startsWith("codex-app-server-error:thread not found:")) throw e;
      const started = await client.request("thread/start", buildThreadStartParams(threadStartBinding));
      threadId = started?.thread?.id;
      if (!threadId) throw new Error(`codex-app-server-thread-start-missing:${payload.from}`);
      peer.threadId = threadId;
      log("info", "Codex app-server wake thread re-seeded", { msgId: payload.msgId, threadId, socketPath });
      if (shouldResumeThread) await resumeThread(threadId);
      result = await startTurn(threadId);
    }
    log("info", "Codex app-server wake completed", { msgId: payload.msgId, threadId, socketPath });
    return result;
  };
};
