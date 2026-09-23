import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { skipUnixSocketWake } from "./windows-host.mjs";
import { ChannelRosterStore } from "../packages/core/dist/src/index.js";
import { WakeMonitor, normalizeWakeConfig } from "../scripts/wake-monitor.mjs";
import {
  buildCodexTurnText,
  buildThreadStartParams,
  buildTurnStartRequest,
  CodexAppServerClient,
  createChannelThreadStartBindingResolver,
  createCodexAppServerInjector,
  deriveRelayReplyMsgId,
  readFinalAnswerFromSessionLog,
} from "../scripts/codex-app-server-wake.mjs";
import { SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";

const payload = {
  from: "agent-jarvis",
  text: "hello codex",
  msgId: "msg-codex-1",
  conversationId: "codex:task:test",
  cursor: 1,
};

test("normalizeWakeConfig accepts Codex app-server peer settings", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          threadId: "thread-1",
        },
      },
    },
  });

  assert.deepEqual(config.peers["agent-jarvis"], {
    mode: "codex_app_server",
    socketPath: "/tmp/codex.sock",
    threadId: "thread-1",
  });
});

test("normalizeWakeConfig preserves Codex reply relay peer settings", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          threadId: "thread-1",
          cwd: "/vault",
          murmurRoot: "/srv/mur-mur-v2",
          dataDir: "/srv/mur-mur-v2/.data-codex",
          storePath: "/srv/mur-mur-v2/.data-codex/murmur.db",
          relayFinalToMurmur: true,
          replyTimeoutMs: "180000",
        },
      },
    },
  });

  assert.deepEqual(config.peers["agent-jarvis"], {
    mode: "codex_app_server",
    socketPath: "/tmp/codex.sock",
    threadId: "thread-1",
    cwd: "/vault",
    murmurRoot: "/srv/mur-mur-v2",
    dataDir: "/srv/mur-mur-v2/.data-codex",
    storePath: "/srv/mur-mur-v2/.data-codex/murmur.db",
    relayFinalToMurmur: true,
    replyTimeoutMs: 180000,
  });
});

test("normalizeWakeConfig preserves the explicit resume opt-out", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          threadId: "thread-1",
          resume: false,
        },
      },
    },
  });

  assert.equal(config.peers["agent-jarvis"].resume, false);
});

test("normalizeWakeConfig preserves per-peer baseInstructions", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          baseInstructions: "You are the critic on this channel.",
        },
      },
    },
  });

  assert.equal(config.peers["agent-jarvis"].baseInstructions, "You are the critic on this channel.");
});

test("buildThreadStartParams carries peer cwd and model into thread/start", () => {
  const params = buildThreadStartParams(null, { cwd: "/work/project", model: "gpt-5.6-sol" });

  assert.equal(params.cwd, "/work/project");
  assert.equal(params.model, "gpt-5.6-sol");
});

test("Codex app-server injector keeps the seeded thread path and skips resume", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "fresh-thread", path: "/tmp/rollout-fresh.jsonl" } };
      }
      return {};
    }

    async startTurnAndWaitForFinal(params, options) {
      calls.push({ method: "turn/start:wait", params, options });
      return { finalText: "done", turnId: "turn-1" };
    }
  }

  const peer = {
    mode: "codex_app_server",
    socketPath: "/tmp/codex.sock",
    cwd: "/work/project",
    relayFinalToMurmur: true,
    murmurRoot: "/work/murmur",
    dataDir: "/work/.data",
    storePath: "/work/.data/murmur.db",
  };
  const injector = createCodexAppServerInjector({ Client: FakeClient, relay: async () => ({ msgId: "reply-1" }) });

  await injector(payload, peer);

  // A thread created right here has no rollout file yet: resuming it can only fail.
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start:wait"]);
  assert.equal(calls[0].params.cwd, "/work/project");
  assert.equal(calls[1].options.sessionPath, "/tmp/rollout-fresh.jsonl");
});

test("buildTurnStartRequest builds Codex turn/start params", () => {
  const request = buildTurnStartRequest({
    id: 7,
    threadId: "thread-1",
    text: buildCodexTurnText(payload),
    metadata: { murmur_msg_id: payload.msgId },
  });

  assert.equal(request.id, 7);
  assert.equal(request.method, "turn/start");
  assert.equal(request.params.threadId, "thread-1");
  assert.equal(request.params.responsesapiClientMetadata.murmur_msg_id, payload.msgId);
  assert.match(request.params.input[0].text, /msgId=msg-codex-1/);
});

test("buildThreadStartParams applies optional channel personality binding", () => {
  const params = buildThreadStartParams({
    model: "gpt-5",
    personality: "codex-writer",
    baseInstructions: "Write concise engineering notes.",
    metadata: { murmur_channel_id: "chan-1" },
  });

  assert.equal(params.model, "gpt-5");
  assert.equal(params.personality, "codex-writer");
  assert.equal(params.baseInstructions, "Write concise engineering notes.");
  assert.equal(params.modelProvider, null);
  assert.equal(params.ephemeral, false);
});

test("buildThreadStartParams preserves legacy nulled defaults without binding", () => {
  const params = buildThreadStartParams();

  assert.equal(params.model, null);
  assert.equal(params.personality, null);
  assert.equal(params.baseInstructions, null);
  assert.equal(params.modelProvider, null);
  assert.equal(params.ephemeral, false);
});

test("Codex app-server client initializes before turn/start over WS-over-UDS", { skip: skipUnixSocketWake }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-wake-"));
  const socketPath = path.join(dir, "codex.sock");
  const received = [];
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      received.push(request);
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ id: request.id, result: { protocolVersion: "0.1.0" } }));
      }
      if (request.method === "turn/start") {
        socket.send(JSON.stringify({ id: request.id, result: { turn: { id: "turn-1" } } }));
      }
    });
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");

  const client = new CodexAppServerClient({ socketPath });
  const result = await client.request("turn/start", {
    threadId: "thread-1",
    input: [{ type: "text", text: buildCodexTurnText(payload), text_elements: [] }],
  });

  wsServer.close();
  httpServer.close();

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  assert.equal(received[0].method, "initialize");
  assert.equal(received[0].params.clientInfo.name, "murmur-codex-app-server-wake");
  assert.equal(received[1].method, "initialized");
  assert.equal(received[2].method, "turn/start");
  assert.equal(received[2].params.threadId, "thread-1");
  assert.match(received[2].params.input[0].text, /msgId=msg-codex-1/);
  assert.match(received[2].params.input[0].text, /hello codex/);
});

test("Codex app-server client fails loud on initialize errors", { skip: skipUnixSocketWake }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-wake-"));
  const socketPath = path.join(dir, "codex.sock");
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ id: request.id, error: { message: "denied" } }));
      }
    });
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");

  const client = new CodexAppServerClient({ socketPath });
  await assert.rejects(
    () => client.request("turn/start", { threadId: "thread-1", input: [] }),
    /codex-app-server-initialize-error:denied/,
  );

  wsServer.close();
  httpServer.close();
});

test("Codex app-server client reports close before response", { skip: skipUnixSocketWake }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-wake-"));
  const socketPath = path.join(dir, "codex.sock");
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.close();
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");

  const client = new CodexAppServerClient({ socketPath });
  await assert.rejects(
    () => client.request("turn/start", { threadId: "thread-1", input: [] }),
    /codex-app-server-closed-before-response:.*:before-initialize/,
  );

  wsServer.close();
  httpServer.close();
});

test("readFinalAnswerFromSessionLog reads task_complete by turn id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-session-log-"));
  const sessionPath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(sessionPath, [
    JSON.stringify({
      timestamp: "2026-07-07T18:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-target",
        last_agent_message: "WAKE_OK",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-07T18:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-other",
        last_agent_message: "WRONG",
      },
    }),
  ].join("\n"));

  assert.equal(readFinalAnswerFromSessionLog(sessionPath, "turn-target"), "WAKE_OK");
});

test("WakeMonitor gates Codex app-server wake before injector", async () => {
  const injected = [];
  let now = 1000;
  const monitor = new WakeMonitor({
    peers: {
      "agent-jarvis": {
        mode: "codex_app_server",
        socketPath: "/tmp/codex.sock",
        threadId: "thread-1",
      },
    },
    dedup: { cooldownMs: 300000 },
    loopBreaker: { maxWakes: 1, windowMs: 60000 },
    auditHook: async (item) => item.msgId === "msg-deny" ? "deny" : "allow",
    injector: async (item, peer) => injected.push({ msgId: item.msgId, mode: peer.mode, threadId: peer.threadId }),
    now: () => now,
  });

  await monitor.onInbound(payload);
  now += 1000;
  await monitor.onInbound({ ...payload, cursor: 2 });
  now += 61000;
  await monitor.onInbound({ ...payload, msgId: "msg-deny", cursor: 3 });

  assert.deepEqual(injected, [{ msgId: "msg-codex-1", mode: "codex_app_server", threadId: "thread-1" }]);
});

test("Codex app-server injector re-seeds stale app-server threads", async () => {
  const calls = [];
  const logs = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "turn/start" && params.threadId === "stale-thread") {
        throw new Error("codex-app-server-error:thread not found: stale-thread");
      }
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const peer = { mode: "codex_app_server", socketPath: "/tmp/codex.sock", threadId: "stale-thread" };
  const injector = createCodexAppServerInjector({
    Client: FakeClient,
    log: (level, message, data) => logs.push({ level, message, data }),
  });

  const result = await injector(payload, peer);

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  // #108 — the seeded thread is remembered per conversation, not written back into config.
  assert.equal(peer.threadId, "stale-thread");
  assert.deepEqual(calls.map((call) => call.method), ["turn/start", "thread/start", "turn/start"]);
  assert.equal(calls[0].params.threadId, "stale-thread");
  assert.equal(calls[2].params.threadId, "fresh-thread");
  assert.equal(logs[0].message, "Codex app-server wake thread re-seeded");
});

test("Codex app-server injector seeds missing app-server threads", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const peer = { mode: "codex_app_server", socketPath: "/tmp/codex.sock" };
  const injector = createCodexAppServerInjector({ Client: FakeClient });

  const result = await injector(payload, peer);

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  // #108 — the seeded thread belongs to this conversation, not to the peer object.
  assert.equal(peer.threadId, undefined);
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start"]);
  assert.equal(calls[1].params.threadId, "fresh-thread");

  await injector({ ...payload, msgId: "msg-codex-2" }, peer);
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start", "turn/start"], "the same conversation reuses its thread");
  assert.equal(calls[2].params.threadId, "fresh-thread");
});

test("Codex app-server injector seeds thread with resolved channel member binding", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-roster-"));
  const roster = new ChannelRosterStore(path.join(dir, "channel-roster.db"));
  roster.createChannel({
    channelId: "chan:codex:writer",
    conversationId: payload.conversationId,
    type: "dm",
    members: [{
      memberId: "codex-writer",
      memberSlot: "agent-codex-volt:writer",
      agentId: "agent-codex-volt",
      personaId: "codex-writer",
      model: "gpt-5",
      baseInstructionsHash: "sha256:writer-v1",
    }],
  });
  const injector = createCodexAppServerInjector({
    Client: FakeClient,
    resolveThreadStartBinding: createChannelThreadStartBindingResolver({
      rosterStore: roster,
      agentId: "agent-codex-volt",
      baseInstructionsResolver: () => "Write concise engineering notes.",
    }),
  });

  const result = await injector(payload, { mode: "codex_app_server", socketPath: "/tmp/codex.sock" });

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.model, "gpt-5");
  assert.equal(calls[0].params.personality, "codex-writer");
  assert.equal(calls[0].params.baseInstructions, "Write concise engineering notes.");
  assert.equal(calls[1].method, "turn/start");
  assert.equal(calls[1].params.responsesapiClientMetadata.murmur_channel_id, "chan:codex:writer");
  assert.equal(calls[1].params.responsesapiClientMetadata.murmur_member_id, "codex-writer");
  assert.equal(calls[1].params.responsesapiClientMetadata.murmur_base_instructions_hash, "sha256:writer-v1");
});

test("channel thread-start binding resolver returns null without member or agent identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-roster-no-id-"));
  const roster = new ChannelRosterStore(path.join(dir, "channel-roster.db"));
  roster.createChannel({
    channelId: "chan:codex:no-id",
    conversationId: payload.conversationId,
    type: "dm",
    members: [{ memberId: "codex-writer", agentId: "agent-codex-volt" }],
  });
  const resolveBinding = createChannelThreadStartBindingResolver({ rosterStore: roster });

  const binding = await resolveBinding(payload, {});

  assert.equal(binding, null);
  roster.close();
});

test("Codex app-server injector ignores remote payload thread-start binding", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const injector = createCodexAppServerInjector({ Client: FakeClient });

  await injector({
    ...payload,
    threadStartBinding: {
      model: "remote-controlled-model",
      personality: "remote-controlled-persona",
      baseInstructions: "remote instructions",
    },
  }, { mode: "codex_app_server", socketPath: "/tmp/codex.sock" });

  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.model, null);
  assert.equal(calls[0].params.personality, null);
  assert.equal(calls[0].params.baseInstructions, null);
});

test("Codex app-server injector fails loud without socket", async () => {
  const injector = createCodexAppServerInjector();

  await assert.rejects(() => injector(payload, { mode: "codex_app_server", threadId: "thread-1" }), /socket-missing/);
});

// #105/#106 — the relay is the side effect that must happen exactly once, and "relayed"
// must never be logged for a turn that produced nothing to relay.

const relayPeer = (storePath) => ({
  mode: "codex_app_server",
  socketPath: "/tmp/codex.sock",
  threadId: "thread-1",
  relayFinalToMurmur: true,
  murmurRoot: "/work/murmur",
  dataDir: path.dirname(storePath),
  storePath,
});

test("Codex app-server relay reply id is derived from the inbound msgId so a retry reuses it", () => {
  const a = deriveRelayReplyMsgId("msg-codex-1");
  assert.equal(a, deriveRelayReplyMsgId("msg-codex-1"));
  assert.notEqual(a, deriveRelayReplyMsgId("msg-codex-2"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("Codex app-server injector hands the derived reply id to the relay and reports it", async () => {
  const relays = [];
  class FakeClient {
    async request() { return {}; }
    async startTurnAndWaitForFinal() { return { finalText: "answer", turnId: "turn-1", source: "session-log" }; }
  }
  const injector = createCodexAppServerInjector({
    Client: FakeClient,
    relay: async (peer, p, text, options) => { relays.push({ text, options }); return { msgId: options.msgId, status: "queued" }; },
    relayAlreadyQueued: async () => false,
  });

  const result = await injector(payload, relayPeer("/work/.data/murmur.db"));

  assert.equal(relays.length, 1);
  assert.equal(relays[0].options.msgId, deriveRelayReplyMsgId(payload.msgId));
  assert.equal(result.replyMsgId, deriveRelayReplyMsgId(payload.msgId));
});

test("Codex app-server injector refuses to report an empty final answer as relayed", async () => {
  const relays = [];
  const logs = [];
  class FakeClient {
    async request() { return {}; }
    async startTurnAndWaitForFinal() { return { finalText: "", turnId: "turn-1", source: "app-server-events" }; }
  }
  const injector = createCodexAppServerInjector({
    Client: FakeClient,
    relay: async () => { relays.push(1); return null; },
    relayAlreadyQueued: async () => false,
    log: (level, message, data) => logs.push({ level, message, data }),
  });

  await assert.rejects(
    injector(payload, relayPeer("/work/.data/murmur.db")),
    (err) => /^codex-app-server-final-empty:turn-1/.test(err.message) && err.retryable === false,
  );
  assert.equal(relays.length, 0);
  assert.ok(!logs.some((entry) => entry.message === "Codex app-server wake final relayed"));
});

test("Codex app-server injector does not restart a turn whose reply is already queued", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-relay-idem-"));
  let outbox;
  try {
    const storePath = path.join(dir, "murmur.db");
    outbox = new SQLiteDedupeOutboxStore(storePath);
    const replyMsgId = deriveRelayReplyMsgId(payload.msgId);
    await outbox.enqueue("msg.agent-jarvis", {
      schemaVersion: "1.0",
      msgId: replyMsgId,
      conversationId: payload.conversationId,
      senderAgentId: "agent-codex",
      recipients: ["agent-jarvis"],
      createdAt: new Date().toISOString(),
      payloadCiphertext: "x",
      payloadNonce: "n",
      signature: "s",
    });

    const calls = [];
    const relays = [];
    class FakeClient {
      async request(method) { calls.push(method); return {}; }
      async startTurnAndWaitForFinal() { calls.push("turn/start:wait"); return { finalText: "again", turnId: "turn-2" }; }
    }
    const injector = createCodexAppServerInjector({ Client: FakeClient, relay: async () => { relays.push(1); return null; } });

    const result = await injector({ ...payload, attempt: 2 }, relayPeer(storePath));

    assert.deepEqual(calls, [], "the previous attempt already produced the reply — Codex must not run the instruction twice");
    assert.equal(relays.length, 0);
    assert.equal(result.source, "relay-idempotent");
    assert.equal(result.replyMsgId, replyMsgId);
  } finally {
    outbox?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #106 — a turn that ended with status "failed" or "interrupted" is not a success, whatever
// text it produced. The status and error come from `turn/completed` itself.

test("Codex app-server client surfaces the turn status and error from turn/completed", { skip: skipUnixSocketWake }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-wake-"));
  const socketPath = path.join(dir, "codex.sock");
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
      if (request.method === "turn/start") {
        socket.send(JSON.stringify({ id: request.id, result: { turn: { id: "turn-9" } } }));
        socket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-9", status: "failed", error: { message: "model exploded" } } } }));
      }
    });
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");
  try {
    const client = new CodexAppServerClient({ socketPath });
    const result = await client.startTurnAndWaitForFinal({ threadId: "thread-1", input: [] }, { completionTimeoutMs: 2000 });
    assert.equal(result.turnId, "turn-9");
    assert.equal(result.status, "failed");
    assert.equal(result.error?.message, "model exploded");
  } finally {
    wsServer.close();
    httpServer.close();
  }
});

test("Codex app-server injector treats a failed turn as a retryable wake failure, not a relay", async () => {
  const relays = [];
  class FakeClient {
    async request() { return {}; }
    async startTurnAndWaitForFinal() { return { finalText: "partial", turnId: "turn-1", source: "app-server-events", status: "failed", error: { message: "model exploded" } }; }
  }
  const injector = createCodexAppServerInjector({ Client: FakeClient, relay: async () => { relays.push(1); return null; }, relayAlreadyQueued: async () => false });

  await assert.rejects(
    injector(payload, relayPeer("/work/.data/murmur.db")),
    (err) => /^codex-app-server-turn-failed:turn-1:model exploded/.test(err.message) && err.retryable !== false,
  );
  assert.equal(relays.length, 0);
});

test("Codex app-server injector does not retry an interrupted turn", async () => {
  class FakeClient {
    async request() { return {}; }
    async startTurnAndWaitForFinal() { return { finalText: "", turnId: "turn-1", source: "app-server-events", status: "interrupted", error: null }; }
  }
  const injector = createCodexAppServerInjector({ Client: FakeClient, relay: async () => null, relayAlreadyQueued: async () => false });

  await assert.rejects(
    injector(payload, relayPeer("/work/.data/murmur.db")),
    (err) => /^codex-app-server-turn-interrupted:turn-1/.test(err.message) && err.retryable === false,
  );
});

// #108 — one Codex thread per (peer, conversation), remembered across restarts. A static
// `peer.threadId` stays an explicit pin; without one, threads are seeded per conversation
// and persisted instead of living in `peer.threadId` for the life of the process.

const memoryThreadStore = () => {
  const map = new Map();
  return {
    map,
    async getWakeThread(peerId, conversationId) { return map.get(`${peerId}|${conversationId}`); },
    async setWakeThread(record) { map.set(`${record.peerId}|${record.conversationId}`, record); },
  };
};

const countingClient = (calls) => class FakeClient {
  async request(method, params) {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${calls.filter((c) => c.method === "thread/start").length}`, path: "/tmp/r.jsonl" } };
    if (method === "thread/resume") return { thread: { id: params.threadId, path: "/tmp/r.jsonl" } };
    return { turn: { id: "turn-1" } };
  }
};

test("Codex app-server injector keeps one thread per peer and conversation and persists it", async () => {
  const calls = [];
  const threadStore = memoryThreadStore();
  const injector = createCodexAppServerInjector({ Client: countingClient(calls), threadStore });
  const peer = { mode: "codex_app_server", socketPath: "/tmp/codex.sock" };

  await injector({ ...payload, msgId: "m-1", conversationId: "conv-x" }, peer);
  await injector({ ...payload, msgId: "m-2", conversationId: "conv-x" }, peer);
  await injector({ ...payload, msgId: "m-3", conversationId: "conv-y" }, peer);

  const starts = calls.filter((c) => c.method === "thread/start");
  assert.equal(starts.length, 2, "one seed per conversation, not per message");
  const turns = calls.filter((c) => c.method === "turn/start").map((c) => c.params.threadId);
  assert.deepEqual(turns, ["thread-1", "thread-1", "thread-2"]);
  assert.equal(threadStore.map.get(`${payload.from}|conv-x`)?.threadId, "thread-1");
  assert.equal(threadStore.map.get(`${payload.from}|conv-y`)?.threadId, "thread-2");
  assert.equal(peer.threadId, undefined, "the peer object is not pinned to the last seeded thread");
});

test("Codex app-server injector resumes the persisted thread after a restart", async () => {
  const threadStore = memoryThreadStore();
  await threadStore.setWakeThread({ peerId: payload.from, conversationId: payload.conversationId, threadId: "thread-kept", threadPath: "/tmp/kept.jsonl" });
  const calls = [];
  const injector = createCodexAppServerInjector({ Client: countingClient(calls), threadStore });

  await injector(payload, { mode: "codex_app_server", socketPath: "/tmp/codex.sock" });

  assert.deepEqual(calls.map((c) => c.method), ["turn/start"]);
  assert.equal(calls[0].params.threadId, "thread-kept");
});

test("Codex app-server injector honours a static peer.threadId as a pin for every conversation", async () => {
  const threadStore = memoryThreadStore();
  const calls = [];
  const injector = createCodexAppServerInjector({ Client: countingClient(calls), threadStore });
  const peer = { mode: "codex_app_server", socketPath: "/tmp/codex.sock", threadId: "live-session" };

  await injector({ ...payload, msgId: "m-1", conversationId: "conv-x" }, peer);
  await injector({ ...payload, msgId: "m-2", conversationId: "conv-y" }, peer);

  assert.deepEqual(calls.map((c) => c.method), ["turn/start", "turn/start"]);
  assert.deepEqual(calls.map((c) => c.params.threadId), ["live-session", "live-session"]);
  assert.equal(threadStore.map.size, 0, "a pinned thread is config, not state");
});

test("Codex app-server injector persists the re-seeded thread when the pinned one is gone", async () => {
  const threadStore = memoryThreadStore();
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "turn/start" && params.threadId === "stale-thread") throw new Error("codex-app-server-error:thread not found: stale-thread");
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const injector = createCodexAppServerInjector({ Client: FakeClient, threadStore });
  const peer = { mode: "codex_app_server", socketPath: "/tmp/codex.sock", threadId: "stale-thread" };

  await injector(payload, peer);
  await injector({ ...payload, msgId: "m-2" }, peer);

  assert.deepEqual(calls.map((c) => c.method), ["turn/start", "thread/start", "turn/start", "turn/start"]);
  assert.equal(calls[3].params.threadId, "fresh-thread", "the second message goes to the re-seeded thread without re-seeding again");
  assert.equal(threadStore.map.get(`${payload.from}|${payload.conversationId}`)?.threadId, "fresh-thread");
});
