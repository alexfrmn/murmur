import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  ChannelRosterStore,
  SQLiteDedupeOutboxStore,
  SQLiteMessageStore,
  stableEnvelopePayload,
  resolveMessageSubject,
  channelScopedSubject,
  type EnvelopeV1,
  type LocalMessageRecord,
} from "@murmurv2/core";
import { encryptPayload, signEnvelope } from "@murmurv2/security";
import { NatsBroker, type BrokerSubscription } from "@murmurv2/broker-nats";
import { codexTaskConversationId, defaultPeerConversationId } from "./codex-routing.js";
import { buildReplyMatcher, waitForReply } from "./request-reply.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface AgentConfig {
  agentId: string;
  memberId?: string;
  natsUrl: string;
  natsToken?: string;
  subject: string;
  subjectScoping?: { enabled?: boolean; channelIds?: string[] };
  dataDir: string;
  keys: {
    encryption: { publicKey: string; privateKey: string };
    signing: { publicKey: string; privateKey: string };
  };
  peers: Record<
    string,
    {
      encryption: { publicKey: string };
      signing: { publicKey: string };
      subject: string;
      subjectScoping?: boolean;
      channelId?: string;
      memberId?: string;
    }
  >;
}

// --- Load agent config (optional — gracefully degrade if missing) ---
const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");
const dbPath = process.env.MURMUR_STORE_PATH ?? path.join(dataDir, "murmur.db");
const channelRosterPath = process.env.MURMUR_CHANNEL_ROSTER_PATH ?? path.join(dataDir, "channel-roster.db");
// One stdio connection is one chat session. Callers cannot impersonate another
// session/agent through tool arguments; hosts may supply their stable session ID.
const presenceSessionId = (process.env.MURMUR_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || `mcp:${randomUUID()}`).trim();
const requestWaitDir = path.resolve(dataDir, ".codex-request-waits");
const taskBindingDir = path.resolve(dataDir, ".codex-task-bindings");

const privateDigestPath = (directory: string, conversationId: string, peerId: string): string => {
  const key = createHash("sha256").update(`${conversationId}\0${peerId}`).digest("hex");
  return path.join(directory, `${key}.json`);
};

const requestWaitPath = (conversationId: string, peerId: string): string => {
  return privateDigestPath(requestWaitDir, conversationId, peerId);
};

const armSynchronousReplySuppression = (conversationId: string, peerId: string, timeoutMs: number): string | null => {
  try {
    mkdirSync(requestWaitDir, { recursive: true, mode: 0o700 });
    chmodSync(requestWaitDir, 0o700);
    const markerPath = requestWaitPath(conversationId, peerId);
    const marker = {
      conversationId,
      peerId,
      pid: process.pid,
      expiresAt: Date.now() + Math.max(1_000, timeoutMs) + 60_000,
    };
    const create = (): string => {
      const fd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeFileSync(fd, JSON.stringify(marker));
      } finally {
        closeSync(fd);
      }
      return markerPath;
    };
    try {
      return create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingLive = true;
      try {
        const existing = JSON.parse(readFileSync(markerPath, "utf8")) as { pid?: number; expiresAt?: number };
        existingLive = Number(existing.expiresAt) >= Date.now();
        if (existingLive && Number.isSafeInteger(existing.pid) && Number(existing.pid) > 0) {
          try { process.kill(Number(existing.pid), 0); } catch { existingLive = false; }
        }
      } catch {
        existingLive = false;
      }
      if (existingLive) throw new Error("murmur-request-already-pending-for-peer-and-conversation");
      rmSync(markerPath, { force: true });
      return create();
    }
  } catch (error) {
    if ((error as Error).message === "murmur-request-already-pending-for-peer-and-conversation") throw error;
    // Suppression is only a convenience. Request/reply must still work if the
    // marker cannot be written.
    return null;
  }
};

const shortenSynchronousReplySuppression = (markerPath: string | null, graceMs = 5_000): void => {
  if (!markerPath) return;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(markerPath, JSON.stringify({ ...marker, expiresAt: Date.now() + graceMs }), { mode: 0o600 });
    const timer = setTimeout(() => clearSynchronousReplySuppression(markerPath), graceMs);
    timer.unref();
  } catch {
    // The receive hook may already have atomically claimed the marker.
  }
};

const recordCodexTaskPeerBinding = (conversationId: string, peerId: string): void => {
  const ownTaskConversationId = codexTaskConversationId(process.env.CODEX_THREAD_ID);
  if (!ownTaskConversationId || conversationId !== ownTaskConversationId) return;
  try {
    mkdirSync(taskBindingDir, { recursive: true, mode: 0o700 });
    chmodSync(taskBindingDir, 0o700);
    const bindingPath = privateDigestPath(taskBindingDir, conversationId, peerId);
    writeFileSync(bindingPath, JSON.stringify({ conversationId, peerId, createdAt: new Date().toISOString() }), { mode: 0o600 });
    chmodSync(bindingPath, 0o600);
  } catch {
    // Binding is a local auto-delivery authorization. A write failure safely
    // degrades replies to inbox-only delivery on the receiving hook.
  }
};

const clearSynchronousReplySuppression = (markerPath: string | null): void => {
  if (!markerPath) return;
  try {
    rmSync(markerPath, { force: true });
  } catch {
    // Best-effort cleanup; stale markers have an expiry and are ignored by the hook.
  }
};

const readPrivateAgentConfig = (filePath: string): AgentConfig => {
  process.umask(0o077);
  const dirStats = lstatSync(path.dirname(filePath));
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) throw new Error("agent-config-directory-invalid");
  if (typeof process.getuid === "function" && dirStats.uid !== process.getuid()) {
    throw new Error("agent-config-directory-owner-mismatch");
  }
  chmodSync(path.dirname(filePath), 0o700);

  const pathStats = lstatSync(filePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) throw new Error("agent-config-file-invalid");
  if (typeof process.getuid === "function" && pathStats.uid !== process.getuid()) {
    throw new Error("agent-config-file-owner-mismatch");
  }
  chmodSync(filePath, 0o600);

  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = fstatSync(fd);
    if (!openedStats.isFile()) throw new Error("agent-config-file-invalid");
    if (typeof process.getuid === "function" && openedStats.uid !== process.getuid()) {
      throw new Error("agent-config-file-owner-mismatch");
    }
    return JSON.parse(readFileSync(fd, "utf8")) as AgentConfig;
  } finally {
    closeSync(fd);
  }
};

let agentConfig: AgentConfig | null = null;
try {
  agentConfig = readPrivateAgentConfig(configPath);
} catch {
  // Agent config not found — send/inbox/peers tools will be unavailable
}

const store = new SQLiteMessageStore(dbPath);
const channelRoster = new ChannelRosterStore(channelRosterPath);

// Outbox store — shared with daemon, only created if agent config exists
let outbox: SQLiteDedupeOutboxStore | null = null;
if (agentConfig) {
  outbox = new SQLiteDedupeOutboxStore(dbPath);
}

// Lazy read-only NATS tap for wake-accelerated murmur_request. Optional — if NATS is
// unreachable we degrade gracefully to pure store polling. A failed connect does NOT
// disable acceleration forever: it's retried after a cooldown so a transient outage at
// startup doesn't permanently fall back to slow polling (per CODEX-VOLT review).
const WAKE_BROKER_RETRY_COOLDOWN_MS = 30_000;
let wakeBroker: NatsBroker | null = null;
let wakeBrokerNextRetry = 0;
const getWakeBroker = async (now: () => number = Date.now): Promise<NatsBroker | null> => {
  if (!agentConfig) return null;
  if (wakeBroker) return wakeBroker;
  if (now() < wakeBrokerNextRetry) return null; // in cooldown after a recent failure
  try {
    const broker = new NatsBroker({
      url: agentConfig.natsUrl,
      token: agentConfig.natsToken,
      jetstream: false,
    });
    await broker.connect();
    wakeBroker = broker;
  } catch {
    // graceful degrade — store polling still resolves the reply; retry after cooldown
    wakeBroker = null;
    wakeBrokerNextRetry = now() + WAKE_BROKER_RETRY_COOLDOWN_MS;
  }
  return wakeBroker;
};

// stableEnvelopePayload is the canonical signing form from @murmurv2/core
// (single source of truth shared by daemon / bridges / runner / demos).

// --- JSON-RPC helpers ---
const send = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const ok = (id: string | number | undefined, result: unknown): void => {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, result });
};

const fail = (id: string | number | undefined, message: string): void => {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
};

const asMessage = (r: LocalMessageRecord): Record<string, unknown> => ({
  id: r.id,
  conversationId: r.conversationId,
  msgId: r.msgId,
  direction: r.direction,
  sender: r.sender,
  text: r.text,
  createdAt: r.createdAt,
  transport: r.transport,
  channelId: r.channelId,
  senderMemberId: r.senderMemberId,
  addresseeMemberId: r.addresseeMemberId,
});

interface RoutingMetadata {
  channelId?: string;
  senderMemberId?: string;
  addresseeMemberId?: string;
}

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
};

const resolveRoutingMetadata = (
  args: Record<string, unknown>,
  config: AgentConfig,
  peer: AgentConfig["peers"][string],
): RoutingMetadata => {
  const channelId = optionalString(args.channelId) ?? optionalString(peer.channelId);
  const senderMemberId = optionalString(args.senderMemberId) ?? optionalString(config.memberId);
  const addresseeMemberId = optionalString(args.addresseeMemberId) ?? optionalString(peer.memberId);
  if (!channelId && !senderMemberId && !addresseeMemberId) return {};
  if (!channelId || !senderMemberId) {
    throw new Error("channelId and senderMemberId are required together for structured routing");
  }
  return { channelId, senderMemberId, addresseeMemberId };
};

// --- Tool handlers ---
const handleTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
  // === Original tools ===
  if (name === "send_message") {
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("text is required");
    const conversationId = String(args.conversationId ?? "local:default");
    const sender = String(args.sender ?? "mcp-client");
    const msgId = String(args.msgId ?? randomUUID());

    const row = await store.append({
      conversationId,
      msgId,
      direction: "outbound",
      sender,
      text,
      createdAt: new Date().toISOString(),
      transport: "mcp",
    });
    return { message: asMessage(row) };
  }

  if (name === "list_conversations") {
    const limit = Number(args.limit ?? 50);
    const conversations = await store.listConversations(Number.isFinite(limit) ? limit : 50);
    return { conversations };
  }

  if (name === "search_messages") {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const limit = Number(args.limit ?? 50);
    const messages = await store.searchMessages(query, Number.isFinite(limit) ? limit : 50);
    return { messages: messages.map(asMessage) };
  }

  if (name === "channel_create") {
    const channelId = String(args.channelId ?? "").trim();
    if (!channelId) throw new Error("channelId is required");
    const conversationId = String(args.conversationId ?? "").trim();
    if (!conversationId) throw new Error("conversationId is required");
    const type = String(args.type ?? "").trim();
    if (!["dm", "group", "consult"].includes(type)) throw new Error("type must be one of: dm, group, consult");
    const members = Array.isArray(args.members) ? args.members as Array<Record<string, unknown>> : [];
    const channel = channelRoster.createChannel({
      channelId,
      conversationId,
      type: type as "dm" | "group" | "consult",
      metadata: typeof args.metadata === "object" && args.metadata && !Array.isArray(args.metadata) ? args.metadata as Record<string, unknown> : undefined,
      members: members.map((member) => ({
        memberId: String(member.memberId ?? "").trim(),
        memberSlot: member.memberSlot === undefined ? undefined : String(member.memberSlot),
        agentId: String(member.agentId ?? "").trim(),
        role: member.role === undefined ? undefined : String(member.role),
        personaId: member.personaId === undefined ? undefined : String(member.personaId),
        model: member.model === undefined ? undefined : String(member.model),
        baseInstructionsHash: member.baseInstructionsHash === undefined ? undefined : String(member.baseInstructionsHash),
        eligibility: typeof member.eligibility === "object" && member.eligibility && !Array.isArray(member.eligibility) ? member.eligibility as Record<string, unknown> : undefined,
        metadata: typeof member.metadata === "object" && member.metadata && !Array.isArray(member.metadata) ? member.metadata as Record<string, unknown> : undefined,
      })),
    });
    return { channel, members: channelRoster.listChannelMembers(channelId) };
  }

  if (name === "channel_list") {
    const conversationId = String(args.conversationId ?? "").trim();
    if (!conversationId) throw new Error("conversationId is required");
    return { channels: channelRoster.listChannelsForConversation(conversationId) };
  }

  if (name === "channel_members") {
    const channelId = String(args.channelId ?? "").trim();
    if (!channelId) throw new Error("channelId is required");
    return { members: channelRoster.listChannelMembers(channelId) };
  }

  if (name === "channel_presence") {
    const channelId = String(args.channelId ?? "").trim();
    if (!channelId) throw new Error("channelId is required");
    return { scope: "local", sessions: channelRoster.listChannelPresence(channelId) };
  }

  if (name === "channel_presence_heartbeat" || name === "channel_presence_leave") {
    if (!agentConfig) throw new Error("agent config not loaded — presence requires a local agent identity");
    if (args.agentId !== undefined || args.sessionId !== undefined) throw new Error("presence identity is bound to this MCP server");
    const identity = {
      channelId: String(args.channelId ?? "").trim(),
      memberId: String(args.memberId ?? agentConfig.memberId ?? "").trim(),
      agentId: agentConfig.agentId,
      sessionId: presenceSessionId,
    };
    if (name === "channel_presence_leave") return { left: channelRoster.leaveChannelSession(identity) };
    return { scope: "local", presence: channelRoster.heartbeatChannelSession({
      ...identity,
      status: args.status as "active" | "idle" | "busy" | undefined,
      ttlMs: args.ttlMs as number | undefined,
    }) };
  }

  if (name === "channel_evaluate_addressing") {
    const selfAgentId = String(args.selfAgentId ?? "").trim();
    if (!selfAgentId) throw new Error("selfAgentId is required");
    return {
      decision: channelRoster.evaluateAddressing({
        channelId: args.channelId === undefined ? undefined : String(args.channelId),
        selfAgentId,
        senderAgentId: args.senderAgentId === undefined ? undefined : String(args.senderAgentId),
        senderMemberId: args.senderMemberId === undefined ? undefined : String(args.senderMemberId),
        addresseeMemberId: args.addresseeMemberId === undefined ? undefined : String(args.addresseeMemberId),
        addresseeAgentId: args.addresseeAgentId === undefined ? undefined : String(args.addresseeAgentId),
      }),
    };
  }

  // === New agent-to-agent tools (require agent config) ===

  if (name === "murmur_send") {
    if (!agentConfig || !outbox) throw new Error("agent config not loaded — run agent-config-init.mjs first");

    const to = String(args.to ?? "").trim();
    if (!to) throw new Error("'to' (recipient agent ID) is required");
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("'text' is required");

    const peer = agentConfig.peers[to];
    if (!peer) throw new Error(`unknown peer: ${to} — add to peers in agent-config.json`);

    const conversationId = String(args.conversationId ?? defaultPeerConversationId({
      to,
      agentId: agentConfig.agentId,
      codexThreadId: process.env.CODEX_THREAD_ID,
    }));
    const msgId = randomUUID();
    const routing = resolveRoutingMetadata(args, agentConfig, peer);

    // Encrypt
    const encrypted = await encryptPayload(
      text,
      peer.encryption.publicKey,
      agentConfig.keys.encryption.privateKey,
    );

    // Build envelope
    const envelope: EnvelopeV1 = {
      schemaVersion: "1.0",
      msgId,
      conversationId,
      senderAgentId: agentConfig.agentId,
      recipients: [to],
      createdAt: new Date().toISOString(),
      payloadCiphertext: encrypted.ciphertext,
      payloadNonce: encrypted.nonce,
      signature: "",
      ...routing,
    };

    // Sign
    envelope.signature = await signEnvelope(
      stableEnvelopePayload(envelope),
      agentConfig.keys.signing.privateKey,
    );

    // Enqueue to outbox — daemon will flush to NATS
    await outbox.enqueue(resolveMessageSubject(peer, routing.channelId), envelope);
    recordCodexTaskPeerBinding(conversationId, to);

    // Store outbound copy in message store
    await store.append({
      conversationId,
      msgId,
      direction: "outbound",
      sender: agentConfig.agentId,
      text,
      createdAt: envelope.createdAt,
      transport: "nats",
      ...routing,
    });

    return { msgId, to, conversationId, status: "queued", ...routing };
  }

  if (name === "murmur_inbox") {
    if (!agentConfig) throw new Error("agent config not loaded — run agent-config-init.mjs first");

    const limit = Number(args.limit ?? 20);
    const effectiveLimit = Number.isFinite(limit) ? limit : 20;
    // Select by direction, not by a text search for the agent's own name: this store
    // belongs to one agent, so every inbound row in it is addressed to that agent.
    // The old searchMessages(agentId) form was a LIKE over text/sender/conversationId
    // and silently returned count:0 for any message that did not spell out the agent's
    // name — delivered, acked, present in local_messages, invisible to the inbox (#114).
    const inbound = await store.listInbound(effectiveLimit);
    return { messages: inbound.map(asMessage), count: inbound.length };
  }

  if (name === "murmur_request") {
    if (!agentConfig || !outbox) throw new Error("agent config not loaded — run agent-config-init.mjs first");

    const to = String(args.to ?? "").trim();
    if (!to) throw new Error("'to' (recipient agent ID) is required");
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("'text' is required");

    const peer = agentConfig.peers[to];
    if (!peer) throw new Error(`unknown peer: ${to} — add to peers in agent-config.json`);

    const timeoutMs = Number(args.timeout_ms ?? 300_000);
    const pollMs = Number(args.poll_interval_ms ?? 10_000);
    const conversationId = String(args.conversationId ?? defaultPeerConversationId({
      to,
      agentId: agentConfig.agentId,
      codexThreadId: process.env.CODEX_THREAD_ID,
    }));
    const msgId = randomUUID();
    const sentAt = new Date().toISOString();
    const routing = resolveRoutingMetadata(args, agentConfig, peer);

    // Encrypt
    const encrypted = await encryptPayload(
      text,
      peer.encryption.publicKey,
      agentConfig.keys.encryption.privateKey,
    );

    // Build envelope
    const envelope: EnvelopeV1 = {
      schemaVersion: "1.0",
      msgId,
      conversationId,
      senderAgentId: agentConfig.agentId,
      recipients: [to],
      createdAt: sentAt,
      payloadCiphertext: encrypted.ciphertext,
      payloadNonce: encrypted.nonce,
      signature: "",
      ...routing,
    };

    // Sign
    envelope.signature = await signEnvelope(
      stableEnvelopePayload(envelope),
      agentConfig.keys.signing.privateKey,
    );

    // Enqueue to outbox
    const suppressionMarker = armSynchronousReplySuppression(conversationId, to, timeoutMs);
    try {
      await outbox.enqueue(resolveMessageSubject(peer, routing.channelId), envelope);
      recordCodexTaskPeerBinding(conversationId, to);
    } catch (error) {
      clearSynchronousReplySuppression(suppressionMarker);
      throw error;
    }

    // Store outbound copy
    try {
      await store.append({
        conversationId,
        msgId,
        direction: "outbound",
        sender: agentConfig.agentId,
        text,
        createdAt: sentAt,
        transport: "nats",
        ...routing,
      });
    } catch (error) {
      clearSynchronousReplySuppression(suppressionMarker);
      throw error;
    }

    // Wait for the reply. Store polling is the durable fallback and always runs;
    // an optional read-only NATS tap on our own subject accelerates the wait by
    // re-checking the store as soon as a matching envelope is observed. The tap is
    // signal-only — the daemon stays the source of truth for decrypt + persistence.
    const graceMs = Number(args.grace_ms ?? 250);
    const deadline = Date.now() + timeoutMs;
    const matchReply = buildReplyMatcher(conversationId, to, routing.addresseeMemberId);

    const broker = await getWakeBroker();
    // Holder object: the tap is attached inside a callback, so a plain `let` would be
    // narrowed to `null` by control-flow analysis. A mutable property keeps its type.
    const tap: { attach: Promise<void> | null; sub: BrokerSubscription | null } = {
      attach: null,
      sub: null,
    };
    let wokenBySignal = false;
    let onSignal: ((wake: () => void) => void) | undefined;
    if (broker) {
      onSignal = (wake) => {
        const subjects = [agentConfig!.subject];
        if (agentConfig!.subjectScoping?.enabled === true && routing.channelId) subjects.push(channelScopedSubject(agentConfig!.subject, routing.channelId));
        const subscriptions: BrokerSubscription[] = [];
        tap.sub = { unsubscribe: async () => { for (const sub of subscriptions) await sub.unsubscribe(); } };
        tap.attach = Promise.all(subjects.map((subject) => broker
          .subscribeRaw(subject, (env) => {
            if (matchReply(env)) {
              wokenBySignal = true;
              wake();
            }
          })
          .then((sub) => {
            subscriptions.push(sub);
          })
          .catch(() => {
            /* tap failed to attach — store polling still resolves the reply */
          }))).then(() => undefined);
      };
    }

    let reply: LocalMessageRecord | null = null;
    try {
      reply = await waitForReply({
        checkStore: async () => {
          const inbound = await store.getInboundAfter(conversationId, sentAt, 100);
          return inbound.find((row) =>
            row.sender === to &&
            (!routing.addresseeMemberId || row.senderMemberId === routing.addresseeMemberId)
          ) ?? null;
        },
        pollMs,
        graceMs,
        deadline,
        onSignal,
      });
    } catch (error) {
      clearSynchronousReplySuppression(suppressionMarker);
      throw error;
    } finally {
      if (tap.attach) await tap.attach;
      if (tap.sub) {
        try {
          await tap.sub.unsubscribe();
        } catch {
          /* ignore unsubscribe errors */
        }
      }
    }

    if (reply) {
      shortenSynchronousReplySuppression(suppressionMarker);
      return {
        status: "received",
        msgId,
        conversationId,
        sentAt,
        ...routing,
        reply: asMessage(reply),
        // Precise telemetry (per CODEX-VOLT review): tapAttached = the read-only NATS
        // tap was live for this wait; wokenBySignal = a matching envelope actually
        // short-circuited the poll (true acceleration, not merely "broker available").
        tapAttached: tap.sub !== null,
        wokenBySignal,
      };
    }

    clearSynchronousReplySuppression(suppressionMarker);

    return {
      status: "timeout",
      msgId,
      conversationId,
      sentAt,
      ...routing,
      timeout_ms: timeoutMs,
      hint: "Use murmur_inbox to check for late responses",
    };
  }

  if (name === "murmur_peers") {
    if (!agentConfig) throw new Error("agent config not loaded — run agent-config-init.mjs first");

    const peerList = Object.entries(agentConfig.peers).map(([id, p]) => ({
      agentId: id,
      subject: p.subject,
      channelId: p.channelId,
      memberId: p.memberId,
      hasEncryptionKey: !!p.encryption?.publicKey,
      hasSigningKey: !!p.signing?.publicKey,
    }));
    return { agentId: agentConfig.agentId, peers: peerList };
  }

  throw new Error(`unknown tool: ${name}`);
};

// --- Tool definitions ---
const tools = [
  {
    name: "send_message",
    description: "Store a local outbound message in the Murmur message store.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        text: { type: "string" },
        sender: { type: "string" },
        msgId: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "list_conversations",
    description: "List known conversations from local persisted message store.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
  },
  {
    name: "search_messages",
    description: "Search local stored messages by text/sender/conversation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "channel_create",
    description: "Create a typed Murmur channel roster entry with optional members.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Stable channel/routing ID, distinct from conversationId" },
        conversationId: { type: "string", description: "Legacy history label associated with the channel" },
        type: { type: "string", enum: ["dm", "group", "consult"] },
        metadata: { type: "object" },
        members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              memberId: { type: "string" },
              memberSlot: { type: "string" },
              agentId: { type: "string" },
              role: { type: "string" },
              personaId: { type: "string" },
              model: { type: "string" },
              baseInstructionsHash: { type: "string" },
              eligibility: { type: "object" },
              metadata: { type: "object" },
            },
            required: ["memberId", "agentId"],
          },
        },
      },
      required: ["channelId", "conversationId", "type"],
    },
  },
  {
    name: "channel_list",
    description: "List typed channels associated with a legacy conversationId.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "channel_members",
    description: "List active and historical members for a typed channel.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
      },
      required: ["channelId"],
    },
  },
  {
    name: "channel_evaluate_addressing",
    description: "Evaluate channel membership/addressing into reject/append/wake decisions.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        selfAgentId: { type: "string" },
        senderAgentId: { type: "string" },
        senderMemberId: { type: "string" },
        addresseeMemberId: { type: "string" },
        addresseeAgentId: { type: "string" },
      },
      required: ["selfAgentId"],
    },
  },
  {
    name: "channel_presence",
    description: "List unexpired local chat-session presence for a channel. Advisory only; not peer liveness or lease ownership.",
    inputSchema: {
      type: "object", properties: { channelId: { type: "string" } }, required: ["channelId"],
    },
  },
  {
    name: "channel_presence_heartbeat",
    description: "Report this local chat session in an existing channel. Repeat before TTL expires; does not claim a lease or grant membership.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        channelId: { type: "string" },
        memberId: { type: "string", description: "Existing local agent member; defaults to configured memberId" },
        status: { type: "string", enum: ["active", "idle", "busy"] },
        ttlMs: { type: "integer", minimum: 5000, maximum: 300000, default: 30000 },
      }, required: ["channelId"],
    },
  },
  {
    name: "channel_presence_leave",
    description: "Remove this local chat session from the channel presence list without changing roster membership or leases.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { channelId: { type: "string" }, memberId: { type: "string" } }, required: ["channelId"],
    },
  },
  {
    name: "murmur_send",
    description:
      "Send an encrypted, signed message to another agent via NATS. Message is queued in outbox and delivered by murmur-daemon.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent ID (must be in peers config)" },
        text: { type: "string", description: "Message text (will be encrypted)" },
        conversationId: { type: "string", description: "Optional conversation ID. In Codex Desktop, omission automatically binds replies to the current task." },
        channelId: { type: "string", description: "Optional typed-channel ID; may default from peer config" },
        senderMemberId: { type: "string", description: "Optional sender member identity; may default from local config" },
        addresseeMemberId: { type: "string", description: "Optional target member identity; may default from peer config" },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "murmur_request",
    description:
      "Send a message and wait for the reply. Combines murmur_send with a durable store-poll, accelerated by a read-only NATS tap so the reply is returned as soon as it lands (falls back to pure polling when NATS is unavailable). The tool blocks until the peer responds or timeout is reached. Ideal for autonomous agent-to-agent conversations.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent ID (must be in peers config)" },
        text: { type: "string", description: "Message text (will be encrypted)" },
        conversationId: { type: "string", description: "Optional conversation ID. In Codex Desktop, omission automatically binds replies to the current task." },
        channelId: { type: "string", description: "Optional typed-channel ID; may default from peer config" },
        senderMemberId: { type: "string", description: "Optional sender member identity; may default from local config" },
        addresseeMemberId: { type: "string", description: "Optional target member identity; may default from peer config" },
        timeout_ms: { type: "number", description: "Max wait time in ms (default: 300000 = 5 min)" },
        poll_interval_ms: { type: "number", description: "Store-poll fallback interval in ms (default: 10000 = 10s)" },
        grace_ms: { type: "number", description: "Delay after a wake signal before re-checking the store, to let the daemon persist (default: 250)" },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "murmur_inbox",
    description:
      "Read inbound messages received from other agents. Messages are decrypted and stored by murmur-daemon.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max messages to return (default 20)" },
      },
    },
  },
  {
    name: "murmur_peers",
    description: "List known peer agents and their key status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// --- JSON-RPC stdio loop ---
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }

  try {
    if (req.method === "initialize") {
      ok(req.id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "murmur-v2-mcp", version: "0.2.0" },
        capabilities: { tools: {} },
      });
      return;
    }

    if (req.method === "tools/list") {
      ok(req.id, { tools });
      return;
    }

    if (req.method === "tools/call") {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const result = await handleTool(name, args);
      ok(req.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      return;
    }

    if (req.method === "notifications/initialized") return;

    fail(req.id, `unsupported method: ${req.method}`);
  } catch (err) {
    fail(req.id, err instanceof Error ? err.message : "request failed");
  }
});
