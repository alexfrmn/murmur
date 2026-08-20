import { createRequire } from "node:module";
import {
  type AckReceiptStore,
  applyJitter,
  computeBackoffMs,
  createAck,
  type AckV1,
  type DedupeStore,
  type EnvelopeV1,
  envelopeDigest,
  isEnvelopeV1,
  isSignedAckV1,
  type OutboxStore,
  type SecurityPolicy,
  type SignedAckV1,
  validateEnvelopePolicy,
} from "@murmurv2/core";

/** Verifies a SignedAckV1 against the pinned signing key of its claimed sender. */
export type WsAckVerifier = (ack: SignedAckV1) => Promise<boolean>;

export interface WsInvalidAckEvent {
  reason: string;
  msgId?: string;
  senderAgentId?: string;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: {
    new(url: string): WsSocket;
    OPEN: number;
  };
  WebSocketServer: new(options: { host?: string; port: number }) => WsServer;
};

interface WsSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate?(): void;
  on(event: "open" | "error" | "close", cb: (...args: unknown[]) => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  address(): { address: string; port: number } | string | null;
  close(cb?: (err?: Error) => void): void;
  on(event: "connection", cb: (socket: WsSocket) => void): void;
  on(event: "listening", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

type WsFrame =
  | { type: "subscribe"; subject: string }
  | { type: "message"; subject: string; envelope: EnvelopeV1 | unknown }
  | { type: "ack"; subject: string; ack: AckV1 | SignedAckV1 };

export interface WebSocketRelayConfig {
  host?: string;
  port: number;
}

export interface WebSocketRelayListenResult {
  url: string;
  port: number;
}

export interface WebSocketBrokerConfig {
  url: string;
}

export type WebSocketMessageHandler = (envelope: EnvelopeV1) => Promise<void>;
export type WebSocketBrokerSubscription = { unsubscribe(): void | Promise<void> };

export function wsSubjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i += 1) {
    const token = p[i];
    if (token === ">") return i === p.length - 1;
    if (i >= s.length) return false;
    if (token !== "*" && token !== s[i]) return false;
  }
  return p.length === s.length;
}

function parseFrame(data: unknown): WsFrame | undefined {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const frame = JSON.parse(text) as WsFrame;
  if (!frame || typeof frame !== "object") return undefined;
  if (frame.type === "subscribe" && typeof frame.subject === "string") return frame;
  if (frame.type === "message" && typeof frame.subject === "string") return frame;
  if (frame.type === "ack" && typeof frame.subject === "string") return frame;
  return undefined;
}

function sendJson(socket: WsSocket, frame: WsFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

export class WebSocketRelay {
  private server?: WsServer;
  private readonly subscriptions = new Map<WsSocket, Set<string>>();

  constructor(private readonly config: WebSocketRelayConfig) {}

  async listen(): Promise<WebSocketRelayListenResult> {
    if (this.server) return this.listenResult();
    this.server = new WebSocketServer({ host: this.config.host, port: this.config.port });
    this.server.on("connection", (socket) => this.addClient(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.on("listening", resolve);
      this.server!.on("error", reject);
    });
    return this.listenResult();
  }

  async close(): Promise<void> {
    if (!this.server) return;
    for (const client of this.server.clients) client.terminate?.();
    const server = this.server;
    this.server = undefined;
    this.subscriptions.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private listenResult(): WebSocketRelayListenResult {
    if (!this.server) throw new Error("websocket-relay-not-listening");
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("websocket-relay-address-unavailable");
    const host = this.config.host ?? (addr.address === "::" ? "127.0.0.1" : addr.address);
    return { url: `ws://${host}:${addr.port}`, port: addr.port };
  }

  private addClient(socket: WsSocket): void {
    this.subscriptions.set(socket, new Set());
    socket.on("message", (data) => {
      try {
        const frame = parseFrame(data);
        if (!frame) return;
        if (frame.type === "subscribe") {
          this.subscriptions.get(socket)?.add(frame.subject);
          return;
        }
        this.broadcast(frame);
      } catch {
        // Malformed relay frames are dropped; subscribers NACK malformed envelopes.
      }
    });
    socket.on("close", () => {
      this.subscriptions.delete(socket);
    });
  }

  private broadcast(frame: Extract<WsFrame, { type: "message" | "ack" }>): void {
    for (const [client, subjects] of this.subscriptions.entries()) {
      if ([...subjects].some((subject) => wsSubjectMatches(subject, frame.subject))) {
        sendJson(client, frame);
      }
    }
  }
}

interface MessageSubscription {
  subject: string;
  consumerId: string;
  dedupe: DedupeStore;
  onMessage: WebSocketMessageHandler;
  maxPoisonAttempts?: number;
  active: boolean;
  queue: Promise<void>;
}

interface AckSubscription {
  subject: string;
  outbox: OutboxStore;
  active: boolean;
  verifyAck?: WsAckVerifier;
  requireSignedAcks?: boolean;
  ackReceipts?: AckReceiptStore;
  onInvalidAck?: (event: WsInvalidAckEvent) => void;
}

export class WebSocketBroker {
  private socket?: WsSocket;
  private connectPromise?: Promise<void>;
  private readonly messageSubscriptions = new Set<MessageSubscription>();
  private readonly ackSubscriptions = new Set<AckSubscription>();
  private readonly failedDeliveries = new Map<string, number>();

  constructor(private readonly config: WebSocketBrokerConfig) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.config.url);
      this.socket = socket;
      socket.on("open", () => resolve());
      socket.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
      socket.on("message", (data) => {
        void this.onFrameData(data);
      });
      socket.on("close", () => {
        this.socket = undefined;
        this.connectPromise = undefined;
      });
    });
    return this.connectPromise;
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = undefined;
    socket.close();
  }

  private async send(frame: WsFrame): Promise<void> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("websocket-not-open");
    }
    this.socket.send(JSON.stringify(frame));
  }

  async publish(subject: string, envelope: EnvelopeV1, policy?: SecurityPolicy): Promise<void> {
    const violations = validateEnvelopePolicy(envelope, policy);
    if (violations.length > 0) {
      throw new Error(`policy-rejected:${violations.join("|")}`);
    }
    await this.send({ type: "message", subject, envelope });
  }

  async publishAck(subject: string, ack: AckV1): Promise<void> {
    await this.send({ type: "ack", subject, ack });
  }

  async subscribeWithAck(params: {
    subject: string;
    consumerId: string;
    dedupe: DedupeStore;
    onMessage: WebSocketMessageHandler;
    maxPoisonAttempts?: number;
  }): Promise<WebSocketBrokerSubscription> {
    await this.connect();
    const sub: MessageSubscription = { ...params, active: true, queue: Promise.resolve() };
    this.messageSubscriptions.add(sub);
    await this.send({ type: "subscribe", subject: params.subject });
    return {
      unsubscribe: () => {
        sub.active = false;
        this.messageSubscriptions.delete(sub);
      },
    };
  }

  async startAckCorrelation(params: {
    outbox: OutboxStore;
    ackSubject: string;
    /** Required to accept signed ACKs. Without it every signed frame is rejected. */
    verifyAck?: WsAckVerifier;
    /** When true, unsigned legacy frames are rejected outright (two-stage rollout). */
    requireSignedAcks?: boolean;
    /** Durable replay protection; see AckReceiptStore in @murmurv2/core. */
    ackReceipts?: AckReceiptStore;
    onInvalidAck?: (event: WsInvalidAckEvent) => void;
  }): Promise<WebSocketBrokerSubscription> {
    await this.connect();
    const sub: AckSubscription = {
      subject: params.ackSubject,
      outbox: params.outbox,
      active: true,
      verifyAck: params.verifyAck,
      requireSignedAcks: params.requireSignedAcks,
      ackReceipts: params.ackReceipts,
      onInvalidAck: params.onInvalidAck,
    };
    this.ackSubscriptions.add(sub);
    await this.send({ type: "subscribe", subject: params.ackSubject });
    return {
      unsubscribe: () => {
        sub.active = false;
        this.ackSubscriptions.delete(sub);
      },
    };
  }

  private async onFrameData(data: unknown): Promise<void> {
    let frame: WsFrame | undefined;
    try {
      frame = parseFrame(data);
    } catch {
      return;
    }
    if (!frame) return;
    if (frame.type === "message") {
      await Promise.all(
        [...this.messageSubscriptions]
          .filter((sub) => sub.active && wsSubjectMatches(sub.subject, frame!.subject))
          .map((sub) => {
            sub.queue = sub.queue
              .then(() => this.processEnvelopeFrame(frame!.envelope, sub))
              .catch((err) => {
                const e = err instanceof Error ? err : new Error(String(err));
                console.error("[WebSocketBroker.subscribeWithAck] loop crashed", { message: e.message, stack: e.stack });
              });
            return sub.queue;
          }),
      );
      return;
    }
    if (frame.type === "ack") {
      await Promise.all(
        [...this.ackSubscriptions]
          .filter((sub) => sub.active && wsSubjectMatches(sub.subject, frame!.subject))
          .map((sub) => this.processAckFrame(frame!.ack, sub, frame!.subject)),
      );
    }
  }

  private async processEnvelopeFrame(raw: unknown, params: MessageSubscription): Promise<void> {
    if (!isEnvelopeV1(raw)) {
      const sender = typeof raw === "object" && raw && typeof (raw as Record<string, unknown>).senderAgentId === "string"
        ? String((raw as Record<string, unknown>).senderAgentId)
        : params.consumerId;
      await this.publishAck(`ack.${sender}`, createAck("unknown", params.consumerId, "nack", "invalid-envelope"));
      return;
    }

    const envelope = raw as EnvelopeV1;
    const ackSubject = `ack.${envelope.senderAgentId}`;
    const isDup = await params.dedupe.seen(envelope.msgId, params.consumerId);
    if (isDup) {
      await this.publishAck(ackSubject, createAck(envelope.msgId, params.consumerId, "ack", "duplicate-ignored"));
      return;
    }

    try {
      await params.onMessage(envelope);
      await params.dedupe.markSeen(envelope.msgId, params.consumerId);
      this.failedDeliveries.delete(`${params.consumerId}:${envelope.msgId}`);
      await this.publishAck(ackSubject, createAck(envelope.msgId, params.consumerId, "ack"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "handler-failed";
      const maxPoisonAttempts = params.maxPoisonAttempts ?? 3;
      const key = `${params.consumerId}:${envelope.msgId}`;
      const failures = (this.failedDeliveries.get(key) ?? 0) + 1;
      this.failedDeliveries.set(key, failures);
      if (failures >= maxPoisonAttempts) {
        await params.dedupe.markSeen(envelope.msgId, params.consumerId);
        this.failedDeliveries.delete(key);
        await this.publishAck(ackSubject, createAck(envelope.msgId, params.consumerId, "nack", `poison-message:${reason}`));
        return;
      }
      await this.publishAck(ackSubject, createAck(envelope.msgId, params.consumerId, "nack", reason));
    }
  }

  /**
   * Apply an inbound ACK frame to the outbox.
   *
   * This path previously trusted the frame outright and called markAcked/markFailed from
   * whatever JSON arrived, so anyone able to reach the relay could settle another peer's
   * pending row. A SignedAckV1 is now verified, bound to the outbox record and claimed
   * once; unsigned frames survive only while `requireSignedAcks` is off, mirroring the
   * two-stage rollout of the NATS broker.
   */
  private async processAckFrame(
    ack: AckV1 | SignedAckV1,
    sub: AckSubscription,
    frameSubject: string,
  ): Promise<void> {
    const reject = (reason: string, senderAgentId?: string, msgId?: string): void => {
      sub.onInvalidAck?.({ reason, senderAgentId, msgId });
    };

    if (!ack || typeof ack.msgId !== "string" || ack.msgId.length === 0) {
      reject("malformed");
      return;
    }

    if (!isSignedAckV1(ack)) {
      if (sub.requireSignedAcks) {
        reject("unsigned-ack-rejected", undefined, ack.msgId);
        return;
      }
      const legacy = ack as AckV1;
      if (legacy.status === "ack") {
        await sub.outbox.markAcked(legacy.msgId);
      } else if (legacy.status === "nack") {
        await sub.outbox.markFailed(legacy.msgId, legacy.reason ?? "nack", new Date().toISOString());
      }
      return;
    }

    const record = await sub.outbox.getOutboxRecord(ack.msgId);
    if (!record) {
      reject("unknown-message", ack.senderAgentId, ack.msgId);
      return;
    }
    if (record.status !== "sent" && record.status !== "pending") {
      reject("message-not-in-flight", ack.senderAgentId, ack.msgId);
      return;
    }
    if (ack.messageDigest !== envelopeDigest(record.envelope)) {
      reject("message-digest-mismatch", ack.senderAgentId, ack.msgId);
      return;
    }
    if (ack.conversationId !== record.envelope.conversationId) {
      reject("conversation-mismatch", ack.senderAgentId, ack.msgId);
      return;
    }
    if (ack.recipientAgentId !== record.envelope.senderAgentId) {
      reject("recipient-mismatch", ack.senderAgentId, ack.msgId);
      return;
    }
    if (!record.envelope.recipients.includes(ack.senderAgentId)) {
      reject("unexpected-peer", ack.senderAgentId, ack.msgId);
      return;
    }
    // The frame must arrive on the subject belonging to the original sender, so a valid
    // ACK cannot be replayed onto an unrelated subscription.
    if (frameSubject !== `ack.${record.envelope.senderAgentId}`) {
      reject("ack-subject-mismatch", ack.senderAgentId, ack.msgId);
      return;
    }
    if (!sub.verifyAck || !(await sub.verifyAck(ack))) {
      reject("signature-invalid", ack.senderAgentId, ack.msgId);
      return;
    }
    if (sub.ackReceipts && !(await sub.ackReceipts.claimAckNonce(ack.senderAgentId, ack.nonce))) {
      reject("nonce-replay", ack.senderAgentId, ack.msgId);
      return;
    }

    const result = await sub.outbox.applyAckTransition(
      ack.msgId,
      ack.status,
      ack.reason ?? "nack",
      new Date().toISOString(),
    );
    if (result !== "applied") reject(`transition-${result}`, ack.senderAgentId, ack.msgId);
  }

  async flushOutbox(params: {
    outbox: OutboxStore;
    maxAttempts?: number;
    batchSize?: number;
    baseBackoffMs?: number;
    jitterRatio?: number;
    ackTimeoutMs?: number;
    policy?: SecurityPolicy;
  }): Promise<void> {
    const maxAttempts = params.maxAttempts ?? 5;
    if (params.ackTimeoutMs && params.outbox.requeueStaleSent) {
      await params.outbox.requeueStaleSent(params.ackTimeoutMs);
    }
    const due = await params.outbox.claimDue(params.batchSize ?? 50);

    for (const rec of due) {
      try {
        await this.publish(rec.subject, rec.envelope, params.policy);
        await params.outbox.markSent(rec.msgId);
      } catch (err) {
        const nextAttemptNum = rec.attempts + 1;
        const reason = err instanceof Error ? err.message : "publish-failed";

        if (reason.startsWith("policy-rejected:")) {
          await params.outbox.markDlq(rec.msgId, reason);
          continue;
        }

        if (nextAttemptNum >= maxAttempts) {
          await params.outbox.markDlq(rec.msgId, reason);
          continue;
        }

        const backoffMs = computeBackoffMs(nextAttemptNum, params.baseBackoffMs ?? 500);
        const withJitter = applyJitter(backoffMs, params.jitterRatio ?? 0.2);
        const nextAt = new Date(Date.now() + withJitter).toISOString();
        await params.outbox.markFailed(rec.msgId, reason, nextAt);
      }
    }
  }
}
