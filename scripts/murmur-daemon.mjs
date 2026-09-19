#!/usr/bin/env node
/**
 * murmur-daemon.mjs — Persistent agent-to-agent messaging daemon.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NatsBroker } from "@murmurv2/broker-nats";
import {
  ChannelRosterStore,
  channelSubjectRoutes,
  SQLiteDedupeOutboxStore,
  SQLiteMessageStore,
  stableAckPayload,
  stableEnvelopePayload,
} from "@murmurv2/core";
import { decryptPayload, signEnvelope, verifyEnvelopeSignature } from "@murmurv2/security";
import { NotifyQueue, flushNotifyQueue, normalizeNotifyTargets, enqueuePeerNotification } from "./notify-router.mjs";
import { createChannelThreadStartBindingResolver, createCodexAppServerInjector } from "./codex-app-server-wake.mjs";
import { startJetStreamAdvisoryDlqIfEnabled } from "./murmur-jetstream-advisory.mjs";
import { WakeMonitor, createAuditShellHook, createShellHook, normalizeWakeConfig } from "./wake-monitor.mjs";
import { SessionLeaseStore, createNativeLeaseGate } from "./lease.mjs";
import { ensurePrivateDirectory, readPrivateJson, setPrivateUmask } from "./secure-state.mjs";
import { createDaemonObservation } from "./daemon-observation.mjs";
// vault-guard: optional content policy hook (not included in OSS release)

setPrivateUmask();

let observeLog = () => {};
const log = (level, msg, data) => {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console.log(JSON.stringify(entry));
  observeLog(level, msg, data);
};

const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");

let config;
try {
  await ensurePrivateDirectory(dataDir);
  config = await readPrivateJson(configPath);
} catch (err) {
  log("fatal", "Cannot load agent config", { path: configPath, error: err.message });
  log("info", "Run: node scripts/agent-config-init.mjs");
  process.exit(1);
}

const { agentId, natsUrl, natsToken, subject, peers, keys } = config;
const dbPath = path.join(dataDir, "murmur.db");
const flushIntervalMs = Number(process.env.FLUSH_INTERVAL_MS) || 2000;
const jetstreamConfig = config.jetstream || {};
const jetstreamEnabled = jetstreamConfig.enabled ?? process.env.MURMUR_JETSTREAM === "1";
const jetstreamStream = jetstreamConfig.stream || process.env.MURMUR_JETSTREAM_STREAM || "MURMUR";
const jetstreamSubjects = jetstreamConfig.subjects || ["msg.>", "ack.>"];
const streamingConfig = config.streaming || {};
const ackWindowConfig = streamingConfig.ackWindow || {};
const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
const optionalPositiveInteger = (name, value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name}-invalid`);
  return parsed;
};
const jetstreamMaxDeliver = optionalPositiveInteger(
  "jetstream-max-deliver",
  firstDefined(jetstreamConfig.maxDeliver, process.env.MURMUR_JETSTREAM_MAX_DELIVER),
);
const jetstreamAckWaitMs = optionalPositiveInteger(
  "jetstream-ack-wait-ms",
  firstDefined(jetstreamConfig.ackWaitMs, process.env.MURMUR_JETSTREAM_ACK_WAIT_MS),
);
const ackTimeoutMs = optionalPositiveInteger(
  "ack-timeout-ms",
  firstDefined(streamingConfig.ackTimeoutMs, process.env.MURMUR_ACK_TIMEOUT_MS),
) ?? 15_000;
const ackSecurityConfig = config.ackSecurity || {};
const emitSignedAcks = process.env.MURMUR_EMIT_SIGNED_ACKS !== undefined
  ? process.env.MURMUR_EMIT_SIGNED_ACKS !== "0"
  : ackSecurityConfig.emitSigned ?? true;
const requireSignedAcks = process.env.MURMUR_REQUIRE_SIGNED_ACKS !== undefined
  ? process.env.MURMUR_REQUIRE_SIGNED_ACKS === "1"
  : ackSecurityConfig.requireSigned ?? false;
const maxAckAgeMs = optionalPositiveInteger(
  "ack-max-age-ms",
  firstDefined(ackSecurityConfig.maxAgeMs, process.env.MURMUR_ACK_MAX_AGE_MS),
) ?? 5 * 60_000;
const ackWindowEnabled = ackWindowConfig.enabled ?? process.env.MURMUR_STREAM_ACK_WINDOW === "1";
const ackWindow = ackWindowEnabled
  ? {
      maxInFlightChunks: optionalPositiveInteger(
        "stream-max-in-flight-chunks",
        firstDefined(ackWindowConfig.maxInFlightChunks, process.env.MURMUR_STREAM_MAX_IN_FLIGHT_CHUNKS),
      ) ?? 64,
      maxInFlightBytes: optionalPositiveInteger(
        "stream-max-in-flight-bytes",
        firstDefined(ackWindowConfig.maxInFlightBytes, process.env.MURMUR_STREAM_MAX_IN_FLIGHT_BYTES),
      ) ?? 4 * 1024 * 1024,
    }
  : undefined;
const notifyTargets = normalizeNotifyTargets(config.notify);
const envTelegramFallback = (() => {
  const botToken = process.env.MURMUR_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.MURMUR_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.MURMUR_TELEGRAM_TOPIC_ID || process.env.TELEGRAM_TOPIC_ID;
  if (notifyTargets.length > 0 || !botToken || !chatId) return [];
  return [{ type: "telegram", channel: "telegram", botToken, chatId, ...(topicId ? { topicId } : {}) }];
})();
const effectiveNotifyTargets = notifyTargets.length > 0 ? notifyTargets : envTelegramFallback;
const notifyQueue = new NotifyQueue(dbPath);
const wakeDb = new DatabaseSync(dbPath);
const wakeConfig = normalizeWakeConfig(config);

log("info", "Daemon starting", {
  agentId,
  subject,
  natsUrl,
  dbPath,
  flushIntervalMs,
  jetstreamEnabled,
  jetstreamStream: jetstreamEnabled ? jetstreamStream : undefined,
  jetstreamMaxDeliver,
  jetstreamAckWaitMs,
  ackTimeoutMs,
  ackSecurity: {
    emitSigned: emitSignedAcks,
    requireSigned: requireSignedAcks,
    maxAgeMs: maxAckAgeMs,
  },
  ackWindow,
  wake: { enabled: wakeConfig.enabled, mode: wakeConfig.mode, hookConfigured: Boolean(config.onReceive) },
  notifyTargets: effectiveNotifyTargets.map((t) => `${t.type}:${t.channel}`),
  notifyFallbackFromEnv: envTelegramFallback.length > 0,
});

if (!wakeConfig.enabled) log("warn", "Wake dispatch paused by configuration", {
  reason: "wake-disabled", pendingPolicy: "preserve-until-enabled",
});

const store = new SQLiteDedupeOutboxStore(dbPath);
const msgStore = new SQLiteMessageStore(dbPath);

// Scoped-channels (#82): native daemon wake becomes a lease-gated fallback. Default OFF
// (backward-compat: no lease -> WakeMonitor behaves exactly as before). Lease lives in its
// own SQLite file (separate WAL) per review.
const scopedChannelsEnabled = config.scopedChannels?.enabled ?? process.env.MURMUR_SCOPED_CHANNELS === "1";
const nativeLeaseTtlMs = Number(process.env.MURMUR_LEASE_TTL_MS) || 20000;
const leaseStore = scopedChannelsEnabled ? new SessionLeaseStore(path.join(dataDir, "lease.db")) : null;
const nativeLeaseGate = leaseStore
  ? createNativeLeaseGate({ store: leaseStore, agentId, ttlMs: nativeLeaseTtlMs, log })
  : null;
if (scopedChannelsEnabled) log("info", "Scoped-channels native lease gate enabled", { ttlMs: nativeLeaseTtlMs });

const channelRosterConfig = config.channelRoster || {};
const channelRosterEnabled = channelRosterConfig.enabled ?? process.env.MURMUR_CHANNEL_ROSTER === "1";
const channelRosterPath = channelRosterConfig.path || process.env.MURMUR_CHANNEL_ROSTER_PATH || path.join(dataDir, "channel-roster.db");
const channelRosterStore = channelRosterEnabled ? new ChannelRosterStore(channelRosterPath) : null;
const subjectRoutes = channelSubjectRoutes(subject, agentId, config.subjectScoping);
if (subjectRoutes.length > 1) {
  if (!jetstreamEnabled || !channelRosterStore) throw new Error("subject-scoping-requires-jetstream-and-roster");
  for (const route of subjectRoutes.slice(1)) {
    const channel = channelRosterStore.getChannel(route.channelId);
    if (!channel || channel.closedAt || !channelRosterStore.findActiveMembersForAgent(agentId).some((m) => m.channelId === route.channelId)) {
      throw new Error(`subject-scoping-inactive-local-channel:${route.channelId}`);
    }
  }
}
const threadStartBindingResolver = channelRosterStore
  ? createChannelThreadStartBindingResolver({ rosterStore: channelRosterStore, agentId, log })
  : null;
const nativeConfigured = wakeConfig.mode === "codex_app_server" || Object.values(wakeConfig.peers).some((peer) => peer.mode === "codex_app_server");
const observation = createDaemonObservation({ dataDir, storePath: dbPath, agentId, log,
  wake: { enabled: wakeConfig.enabled, mode: nativeConfigured ? "monitor" : config.onReceive ? "hook" : "none",
    // A custom shell command's identity cannot be inferred from arbitrary text.
    responder: nativeConfigured ? "codex" : config.onReceive ? null : "none" } });
observeLog = observation.observeLog;
// #108 — Codex threads are remembered per (peer, conversation) in the message store.
const codexAppServerInjector = createCodexAppServerInjector({ log, resolveThreadStartBinding: threadStartBindingResolver, threadStore: msgStore });
if (channelRosterEnabled) log("info", "Channel roster thread-start binding enabled", { channelRosterPath });
const broker = new NatsBroker({
  url: natsUrl,
  token: natsToken,
  jetstream: jetstreamEnabled,
  stream: jetstreamEnabled ? jetstreamStream : undefined,
  streamSubjects: jetstreamSubjects,
  jetstreamMaxDeliver,
  jetstreamAckWaitMs,
  onStatus: (event) => observation.onStatus(event),
});

const signAck = async (unsignedAck) => ({
  ...unsignedAck,
  signature: await signEnvelope(stableAckPayload(unsignedAck), keys.signing.privateKey),
});

const verifyAck = async (ack) => {
  const peer = peers[ack.senderAgentId];
  if (!peer?.signing?.publicKey) return false;
  return verifyEnvelopeSignature(stableAckPayload(ack), ack.signature, peer.signing.publicKey);
};

const durableSafe = (value) => value.replace(/[^A-Za-z0-9_-]/g, "-");

const inboundCursor = () => {
  const row = wakeDb.prepare("SELECT COALESCE(MAX(rowid), 0) as cursor FROM local_messages WHERE direction = 'inbound'").get();
  return Number(row?.cursor ?? 0);
};

const enqueueWakeNotification = async (payload, reason) => {
  log("warn", "WakeMonitor fallback notify", { reason, msgId: payload.msgId, from: payload.from });
  enqueuePeerNotification({ queue: notifyQueue, targets: effectiveNotifyTargets, payload, log, reason });
};

// #105 — the message store is the wake queue. Backlog, retries and the cursor all come
// from the rows' durable wake state; nothing about a delivery lives only in this process.
const wakeMonitor = new WakeMonitor({
  ...wakeConfig,
  deliveries: msgStore,
  leaseGate: nativeLeaseGate,
  auditHook: createAuditShellHook({ command: wakeConfig.auditHook, log }),
  hook: createShellHook({ command: config.onReceive, timeoutMs: wakeConfig.hookTimeoutMs, log }),
  injector: async (payload, peer) => {
    if (peer.mode === "codex_app_server") {
      return codexAppServerInjector(payload, peer);
    }
    throw new Error(`wake-native-mode-unsupported:${peer.mode}`);
  },
  notify: enqueueWakeNotification,
  log,
});

const proxyWakeMonitor = new WakeMonitor({
  ...wakeConfig,
  initialCursor: inboundCursor(),
  auditHook: createAuditShellHook({ command: wakeConfig.auditHook, log }),
  hook: createShellHook({ command: config.proxyOnReceive, timeoutMs: wakeConfig.hookTimeoutMs, log }),
  leaseGate: nativeLeaseGate,
  injector: async (payload, peer) => {
    if (peer.mode === "codex_app_server") {
      return codexAppServerInjector(payload, peer);
    }
    throw new Error(`wake-native-mode-unsupported:${peer.mode}`);
  },
  notify: enqueueWakeNotification,
  log,
});


const onMessage = async (envelope) => {
  const senderId = envelope.senderAgentId;
  const peer = peers[senderId];

  if (!peer) {
    // Отказ обязан быть виден ПРИНИМАЮЩЕЙ стороне. Бросок уходит в
    // broker.subscribeWithAck, тот шлёт отправителю nack с причиной — и на этом всё:
    // у владельца машины отвергнутого сообщения нет нигде, ни в логе, ни в базе.
    // Найдено agent-misha 2026-09-08: три агента час выясняли, доходит ли сообщение,
    // потому что принимающая сторона своих отказов не видела.
    log("warn", "Message rejected", {
      reason: "unknown-sender",
      senderId,
      msgId: envelope.msgId,
      conversationId: envelope.conversationId,
    });
    throw new Error(`unknown-sender:${senderId}`);
  }

  const sigPayload = stableEnvelopePayload(envelope);
  const valid = await verifyEnvelopeSignature(sigPayload, envelope.signature, peer.signing.publicKey);
  if (!valid) {
    // Важнее предыдущего: неизвестный отправитель — это чаще всего незаконченная
    // настройка, а невалидная подпись при ИЗВЕСТНОМ пире означает либо рассинхрон
    // ключей, либо попытку писать от чужого имени. Молча такое проходить не должно.
    log("warn", "Message rejected", {
      reason: "signature-invalid",
      senderId,
      msgId: envelope.msgId,
      conversationId: envelope.conversationId,
    });
    throw new Error(`signature-invalid:${senderId}`);
  }

  const plaintext = await decryptPayload(
    {
      ciphertext: envelope.payloadCiphertext,
      nonce: envelope.payloadNonce,
      senderPublicKey: peer.encryption.publicKey,
    },
    keys.encryption.privateKey,
  );

  const addressing = channelRosterStore?.evaluateAddressing({
    channelId: envelope.channelId,
    selfAgentId: agentId,
    senderAgentId: senderId,
    senderMemberId: envelope.senderMemberId,
    addresseeMemberId: envelope.addresseeMemberId,
  });
  if (addressing?.reject) throw new Error(`channel-addressing-rejected:${addressing.reason}`);
  const wakeEligible = addressing?.allowWake !== false;

  // Durable commit first (#105): the row, its delivery id and its wake state land in
  // one transaction. Returning from here is what lets the broker mark the envelope seen
  // and ACK it — so the ACK now means "stored", not "the wake finished".
  const stored = await msgStore.append({
    conversationId: envelope.conversationId,
    msgId: envelope.msgId,
    direction: "inbound",
    sender: senderId,
    text: plaintext,
    createdAt: envelope.createdAt,
    transport: "nats",
    channelId: envelope.channelId,
    senderMemberId: envelope.senderMemberId,
    addresseeMemberId: envelope.addresseeMemberId,
    wakeEligible,
  });
  if (stored.duplicate) {
    // Crash window "receiver committed, ACK lost": the sender (or JetStream) delivered
    // the same envelope again. The delivery already succeeded — ACK it, wake nothing.
    log("info", "Message duplicate ignored", {
      msgId: envelope.msgId,
      from: senderId,
      conversationId: envelope.conversationId,
      rowid: stored.rowid,
    });
    return;
  }

  log("info", "Message received", {
    msgId: envelope.msgId,
    from: senderId,
    conversationId: envelope.conversationId,
    channelId: envelope.channelId,
    senderMemberId: envelope.senderMemberId,
    addresseeMemberId: envelope.addresseeMemberId,
    wakeEligible,
    textLen: plaintext.length,
  });

  const payload = {
    from: senderId,
    text: plaintext,
    msgId: envelope.msgId,
    conversationId: envelope.conversationId,
    channelId: envelope.channelId,
    senderMemberId: envelope.senderMemberId,
    addresseeMemberId: envelope.addresseeMemberId,
    wakeEligible,
    ts: new Date().toISOString(),
    cursor: stored.rowid,
  };

  if (effectiveNotifyTargets.length > 0 && wakeEligible) {
    enqueuePeerNotification({ queue: notifyQueue, targets: effectiveNotifyTargets, payload, log });
  }

  // The wake runs off the durable queue, not on the broker's clock. Awaiting it here
  // used to hold the sender's ACK (and JetStream's ack_wait) for the whole Codex turn —
  // minutes — so the sender's ACK timeout resent the envelope while the first copy was
  // still being processed. Failures are retried from the row; nothing is lost by not
  // waiting.
  if (wakeEligible) {
    wakeMonitor.onInbound(payload).catch((err) => {
      log("error", "WakeMonitor onInbound failed", { error: err instanceof Error ? err.message : String(err), msgId: envelope.msgId });
    });
  }
};

let running = true;

const flushLoop = async () => {
  while (running) {
    try {
      await broker.flushOutbox({ outbox: store, maxAttempts: 5, ackTimeoutMs, ackWindow });
    } catch (err) {
      log("error", "Outbox flush error", { error: err.message });
    }

    try {
      await flushNotifyQueue({ queue: notifyQueue, log, limit: 100 });
    } catch (err) {
      log("error", "Notify flush error", { error: err.message });
    }

    // #105 — retry tick: deliveries whose backoff has elapsed, and anything a previous
    // process left behind, are picked up from the table here.
    try {
      await wakeMonitor.drain();
    } catch (err) {
      log("error", "Wake retry drain error", { error: err.message });
    }

    await sleep(flushIntervalMs);
  }
};

const shutdown = async (signal) => {
  log("info", "Shutdown signal received, draining NATS", { signal });
  running = false;
  observation.stop();
  try {
    await broker.close();
  } catch (err) {
    log("error", "Broker close error", { error: err.message });
  }
  log("info", "Daemon stopped", { agentId });
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await observation.start();
  await broker.connect();
  await observation.connected();
  log("info", "NATS connected", { url: natsUrl });

  for (const route of subjectRoutes) {
    await broker.subscribeWithAck({
      ...route,
      consumerId: agentId,
      dedupe: store,
      onMessage,
      ...(emitSignedAcks ? { signAck } : {}),
    });
    log("info", "Subscribed", route);
  }

  // Proxy wake bridges cannot confirm delivery on behalf of another agent.
  const proxySubjects = (config.proxySubjects || []);
  for (const ps of proxySubjects) {
    const proxyAgentId = ps.replace(/^msg\./, "");
    const proxyOnMessage = async (envelope, plaintext) => {
      const senderId = envelope.senderAgentId || "unknown";
      const addressing = channelRosterStore?.evaluateAddressing({
        channelId: envelope.channelId,
        selfAgentId: proxyAgentId,
        senderAgentId: senderId,
        senderMemberId: envelope.senderMemberId,
        addresseeMemberId: envelope.addresseeMemberId,
      });
      if (addressing?.reject) throw new Error(`channel-addressing-rejected:${addressing.reason}`);
      const wakeEligible = addressing?.allowWake !== false;
      log("info", "Proxy message received", {
        subject: ps,
        from: senderId,
        channelId: envelope.channelId,
        senderMemberId: envelope.senderMemberId,
        addresseeMemberId: envelope.addresseeMemberId,
        wakeEligible,
        len: plaintext?.length,
      });
      await proxyWakeMonitor.onInbound({
        from: senderId,
        text: plaintext ?? "",
        msgId: envelope.msgId,
        conversationId: envelope.conversationId,
        channelId: envelope.channelId,
        senderMemberId: envelope.senderMemberId,
        addresseeMemberId: envelope.addresseeMemberId,
        wakeEligible,
        ts: new Date().toISOString(),
        env: { MURMUR_PROXY_AGENT: proxyAgentId },
      });
    };
    await broker.subscribeWithAck({
      subject: ps,
      consumerId: `${agentId}-proxy-${durableSafe(ps)}`,
      dedupe: store,
      onMessage: proxyOnMessage,
      emitDeliveryAcks: false,
    });
    log("warn", "Subscribed (proxy wake only); without an addressed agent daemon, delivery is unconfirmed and sender retries end in DLQ", { subject: ps });
  }

  // `store` is a SQLiteDedupeOutboxStore, which also implements AckReceiptStore: ACK nonces
  // are claimed in the same database as the outbox, so replay protection survives a daemon
  // restart. Without this the broker falls back to an in-memory set that forgets everything
  // on exit.
  const ackReceipts = typeof store.claimAckNonce === "function" ? store : undefined;
  await broker.startAckCorrelation({
    outbox: store,
    ackReceipts,
    ackSubject: `ack.${agentId}`,
    consumerId: `${agentId}-ack`,
    verifyAck,
    requireSignedAcks,
    maxAckAgeMs,
    onInvalidAck: (event) => log("warn", "Invalid ACK rejected", event),
  });
  log("info", "ACK correlation started", {
    ackSubject: `ack.${agentId}`,
    emitSignedAcks,
    requireSignedAcks,
    durableAckReplayProtection: Boolean(ackReceipts),
  });
  if (!ackReceipts) {
    log("warn", "ACK replay protection is in-memory only — nonces are forgotten on restart", {
      hint: "use the SQLite store (storePath) so ack_receipts is persisted",
    });
  }
  await startJetStreamAdvisoryDlqIfEnabled({
    broker,
    outbox: store,
    jetstreamEnabled,
    log,
  });

  const pendingNotify = notifyQueue.pendingCount();
  if (pendingNotify > 0) {
    log("info", "Resuming pending notifications", { pendingNotify });
    await flushNotifyQueue({ queue: notifyQueue, log, limit: 250 });
  }

  flushLoop();
  // Wake readiness belongs in the readiness line. A daemon with no responder accepts,
  // decrypts, stores and ACKs every message exactly like a healthy one — the difference
  // is only visible once somebody waits for a reply that nobody was ever going to write.
  // `wake` is additive: `agentId` and `peers` keep their shape for existing log readers.
  const wakeStatus = wakeMonitor.responderStatus();
  if (!wakeStatus.configured) {
    log("warn", "No wake responder configured - inbound messages will be stored and nothing else", {
      hint: "set onReceive (shell hook), or wake.peers[<agentId>].mode=codex_app_server (native wake), in agent-config.json",
    });
  }
  log("info", "Daemon ready", { agentId, peers: Object.keys(peers), wake: wakeStatus });
} catch (err) {
  log("fatal", "Daemon startup failed", { error: err.message });
  await broker.close().catch(() => {});
  process.exit(1);
}
