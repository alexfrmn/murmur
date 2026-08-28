import {
  AckPolicy,
  connect,
  DeliverPolicy,
  type ConnectionOptions,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  StringCodec,
  type Subscription,
} from "nats";
import {
  applyJitter,
  computeBackoffMs,
  createAck,
  createBoundAck,
  envelopeDigest,
  estimateBase64DecodedBytes,
  type EnvelopeV1,
  isSignedAckV1,
  isEnvelopeV1,
  isSignedPresenceFrameV1,
  type SignedPresenceFrameV1,
  type AckReceiptStore,
  type DedupeStore,
  type OutboxStore,
  type AckV1,
  type SignedAckV1,
  type SecurityPolicy,
  type UnsignedAckV1,
  streamBackpressureAllowsSend,
  validateEnvelopePolicy,
} from "@murmurv2/core";

export interface BrokerConfig {
  url: string;
  jetstream?: boolean;
  stream?: string;
  streamSubjects?: string[];
  jetstreamMaxDeliver?: number;
  jetstreamAckWaitMs?: number;
  token?: string;
  connectMaxAttempts?: number;
  connectBaseBackoffMs?: number;
  connectJitterRatio?: number;
  maxReconnectAttempts?: number;
  reconnectTimeWait?: number;
  reconnectJitter?: number;
  pingInterval?: number;
  maxPingOut?: number;
  waitOnFirstConnect?: boolean;
  onStatus?: (status: BrokerStatusEvent) => void;
}

export type MessageHandler = (envelope: EnvelopeV1) => Promise<void>;
export type BrokerSubscription = Subscription | { unsubscribe(): void | Promise<void> };

/**
 * Optional ingress authorizer. Returns whether an inbound envelope is allowed before
 * it reaches the consumer's `onMessage`. INJECTED (not imported) so broker-nats stays
 * free of a @murmurv2/federation dependency — the daemon wires `authorizeInbound` here
 * only when `MURMUR_ENFORCE_AUTH` is on (default OFF → no authorize hook → no
 * enforcement). A rejected envelope is NACKed `auth-rejected:<reason>` and never
 * delivered. The hook MUST NOT log the token body.
 */
export type InboundAuthorizer = (envelope: EnvelopeV1) => Promise<{ accepted: boolean; reason?: string }>;

export interface BrokerStatusEvent {
  type: string;
  data?: unknown;
  reconnects: number;
}

export interface AckWindowConfig {
  maxInFlightChunks: number;
  maxInFlightBytes: number;
}

export type AckSigner = (ack: UnsignedAckV1) => Promise<SignedAckV1>;
export type AckVerifier = (ack: SignedAckV1) => Promise<boolean>;

export interface InvalidAckEvent {
  reason: string;
  msgId?: string;
  senderAgentId?: string;
}

interface JetStreamConsumerAdvisory {
  type?: string;
  stream?: string;
  consumer?: string;
  stream_seq?: number;
  deliveries?: number;
}

export const buildNatsConnectionOptions = (config: BrokerConfig): ConnectionOptions => ({
  servers: config.url,
  token: config.token,
  maxReconnectAttempts: config.maxReconnectAttempts ?? -1,
  reconnectTimeWait: config.reconnectTimeWait ?? 2000,
  reconnectJitter: config.reconnectJitter ?? 500,
  pingInterval: config.pingInterval ?? 20000,
  maxPingOut: config.maxPingOut ?? 2,
  waitOnFirstConnect: config.waitOnFirstConnect ?? true,
});

export class NatsBroker {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private readonly sc = StringCodec();
  private readonly failedDeliveries = new Map<string, number>();
  private readonly seenAckNonces = new Set<string>();
  private readonly invalidAckCounts = new Map<string, number>();
  private reconnects = 0;
  private statusLoop?: Promise<void>;

  constructor(private readonly config: BrokerConfig) {}

  async connect(): Promise<void> {
    if (this.nc) {
      await this.ensureJetStream();
      return;
    }

    const maxAttempts = this.config.connectMaxAttempts ?? 5;
    const baseBackoffMs = this.config.connectBaseBackoffMs ?? 250;
    const jitterRatio = this.config.connectJitterRatio ?? 0.2;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.nc = await connect(buildNatsConnectionOptions(this.config));
        this.startStatusLoop(this.nc);
        await this.ensureJetStream();
        return;
      } catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts) break;
        const sleepMs = applyJitter(computeBackoffMs(attempt, baseBackoffMs), jitterRatio);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("nats-connect-failed");
  }

  async close(): Promise<void> {
    if (!this.nc) return;
    await this.nc.drain();
    this.nc = undefined;
  }

  getReconnectCount(): number {
    return this.reconnects;
  }

  getAckSecurityMetrics(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.invalidAckCounts.entries());
  }

  private jetStreamEnabled(): boolean {
    return this.config.jetstream === true || !!this.config.stream;
  }

  private streamName(): string {
    return this.config.stream ?? "MURMUR";
  }

  private streamSubjects(): string[] {
    return this.config.streamSubjects ?? ["msg.>", "ack.>"];
  }

  private jetStreamMaxDeliver(): number {
    const value = this.config.jetstreamMaxDeliver ?? 5;
    if (!Number.isFinite(value) || value < 1) {
      throw new Error("jetstream-max-deliver-invalid");
    }
    return Math.trunc(value);
  }

  private jetStreamAckWaitNanos(): number {
    const ackWaitMs = this.config.jetstreamAckWaitMs ?? 30000;
    if (!Number.isFinite(ackWaitMs) || ackWaitMs <= 0) {
      throw new Error("jetstream-ack-wait-invalid");
    }
    return Math.trunc(ackWaitMs * 1_000_000);
  }

  private buildJetStreamConsumerConfig(subject: string, durableName: string) {
    return {
      durable_name: durableName,
      name: durableName,
      filter_subject: subject,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      max_deliver: this.jetStreamMaxDeliver(),
      ack_wait: this.jetStreamAckWaitNanos(),
    };
  }

  private async ensureJetStream(): Promise<void> {
    if (!this.jetStreamEnabled() || !this.nc) return;
    if (this.js && this.jsm) return;

    this.jsm = await this.nc.jetstreamManager();
    const stream = this.streamName();
    const subjects = this.streamSubjects();

    try {
      const info = await this.jsm.streams.info(stream);
      const currentSubjects = new Set(info.config.subjects ?? []);
      const missingSubjects = subjects.filter((subject) => !currentSubjects.has(subject));
      if (missingSubjects.length > 0) {
        await this.jsm.streams.update(stream, {
          ...info.config,
          subjects: [...currentSubjects, ...missingSubjects],
        });
      }
    } catch {
      await this.jsm.streams.add({
        name: stream,
        subjects,
      });
    }

    this.js = this.nc.jetstream();
  }

  private startStatusLoop(nc: NatsConnection): void {
    if (this.statusLoop) return;
    this.statusLoop = (async () => {
      for await (const status of nc.status()) {
        if (status.type === "reconnect") this.reconnects += 1;
        if (status.type === "disconnect" || status.type === "reconnect" || status.type === "update") {
          const event = { type: status.type, data: status.data, reconnects: this.reconnects };
          this.config.onStatus?.(event);
          console.info("[NatsBroker.status]", event);
        }
      }
    })().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[NatsBroker.status] loop crashed", { message: e.message, stack: e.stack });
    }).finally(() => {
      this.statusLoop = undefined;
    });
  }

  async publish(subject: string, envelope: EnvelopeV1, policy?: SecurityPolicy): Promise<void> {
    const violations = validateEnvelopePolicy(envelope, policy);
    if (violations.length > 0) {
      throw new Error(`policy-rejected:${violations.join("|")}`);
    }
    await this.connect();
    const payload = this.sc.encode(JSON.stringify(envelope));
    if (this.js) {
      await this.js.publish(subject, payload, { msgID: envelope.msgId });
      return;
    }
    this.nc!.publish(subject, payload);
  }

  async publishAck(subject: string, envelope: AckV1 | SignedAckV1): Promise<void> {
    await this.connect();
    const payload = this.sc.encode(JSON.stringify(envelope));
    const ackSender = "senderAgentId" in envelope ? envelope.senderAgentId : envelope.consumerId;
    const nonce = "nonce" in envelope ? `:${envelope.nonce}` : "";
    if (this.js) {
      await this.js.publish(subject, payload, {
        msgID: `ack:${envelope.msgId}:${ackSender}:${envelope.status}${nonce}`,
      });
      return;
    }
    this.nc!.publish(subject, payload);
  }

  private async createDeliveryAck(
    envelope: EnvelopeV1,
    consumerId: string,
    status: AckV1["status"],
    reason: string | undefined,
    signAck: AckSigner | undefined,
  ): Promise<AckV1 | SignedAckV1> {
    if (!signAck) return createAck(envelope.msgId, consumerId, status, reason);
    return signAck(createBoundAck(envelope, consumerId, status, reason));
  }

  private async processEnvelopeFrame(
    data: Uint8Array,
    params: {
      consumerId: string;
      dedupe: DedupeStore;
      onMessage: MessageHandler;
      maxPoisonAttempts?: number;
      authorize?: InboundAuthorizer;
      signAck?: AckSigner;
    },
  ): Promise<"ack" | "retry"> {
    let msgId = "unknown";
    let ackSubject = `ack.${params.consumerId}`;
    let decodedEnvelope: EnvelopeV1 | undefined;
    try {
      const decoded = JSON.parse(this.sc.decode(data));
      if (!isEnvelopeV1(decoded)) {
        await this.publishAck(ackSubject, createAck("unknown", params.consumerId, "nack", "invalid-envelope"));
        return "ack";
      }

      decodedEnvelope = decoded;
      msgId = decoded.msgId;
      ackSubject = `ack.${decoded.senderAgentId}`;
      const isDup = await params.dedupe.seen(decoded.msgId, params.consumerId);
      if (isDup) {
        await this.publishAck(
          ackSubject,
          await this.createDeliveryAck(decoded, params.consumerId, "ack", "duplicate-ignored", params.signAck),
        );
        return "ack";
      }

      // Ingress authorization (PR-D2). Only enforced when an authorizer is wired
      // (daemon does so when MURMUR_ENFORCE_AUTH is on). A rejected envelope is
      // terminal: NACK auth-rejected:<reason>, never delivered, not retried.
      if (params.authorize) {
        const authz = await params.authorize(decoded);
        if (!authz.accepted) {
          await this.publishAck(
            ackSubject,
            await this.createDeliveryAck(
              decoded,
              params.consumerId,
              "nack",
              `auth-rejected:${authz.reason ?? "denied"}`,
              params.signAck,
            ),
          );
          return "ack";
        }
      }

      await params.onMessage(decoded);
      await params.dedupe.markSeen(decoded.msgId, params.consumerId);
      this.failedDeliveries.delete(`${params.consumerId}:${decoded.msgId}`);
      await this.publishAck(
        ackSubject,
        await this.createDeliveryAck(decoded, params.consumerId, "ack", undefined, params.signAck),
      );
      return "ack";
    } catch (err) {
      const reason = err instanceof Error ? err.message : "handler-failed";
      const maxPoisonAttempts = params.maxPoisonAttempts ?? 3;
      const key = `${params.consumerId}:${msgId}`;
      const failures = (this.failedDeliveries.get(key) ?? 0) + 1;
      this.failedDeliveries.set(key, failures);
      if (msgId !== "unknown" && failures >= maxPoisonAttempts) {
        await params.dedupe.markSeen(msgId, params.consumerId);
        this.failedDeliveries.delete(key);
        const ack = decodedEnvelope
          ? await this.createDeliveryAck(
              decodedEnvelope,
              params.consumerId,
              "nack",
              `poison-message:${reason}`,
              params.signAck,
            )
          : createAck(msgId, params.consumerId, "nack", `poison-message:${reason}`);
        await this.publishAck(ackSubject, ack);
        return "ack";
      }
      const ack = decodedEnvelope
        ? await this.createDeliveryAck(decodedEnvelope, params.consumerId, "nack", reason, params.signAck)
        : createAck(msgId, params.consumerId, "nack", reason);
      await this.publishAck(ackSubject, ack);
      return "retry";
    }
  }

  private async ensureJetStreamConsumer(subject: string, durableName: string): Promise<void> {
    if (!this.jsm) throw new Error("jetstream-manager-unavailable");
    const stream = this.streamName();
    const config = this.buildJetStreamConsumerConfig(subject, durableName);
    let info;
    try {
      info = await this.jsm.consumers.info(stream, durableName);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("jetstream-consumer-filter-mismatch:")) {
        throw err;
      }
      await this.jsm.consumers.add(stream, config);
      return;
    }

    const filterSubject = info.config.filter_subject;
    if (filterSubject && filterSubject !== subject) {
      throw new Error(`jetstream-consumer-filter-mismatch:${durableName}:${filterSubject}:${subject}`);
    }
    if (info.config.max_deliver !== config.max_deliver || info.config.ack_wait !== config.ack_wait) {
      await this.jsm.consumers.update(stream, durableName, {
        max_deliver: config.max_deliver,
        ack_wait: config.ack_wait,
      });
    }
  }

  private async consumeJetStream(
    subject: string,
    durableName: string,
    onMessage: (data: Uint8Array) => Promise<"ack" | "retry" | void>,
  ): Promise<BrokerSubscription> {
    await this.ensureJetStreamConsumer(subject, durableName);
    if (!this.js) throw new Error("jetstream-client-unavailable");

    const consumer = await this.js.consumers.get(this.streamName(), durableName);
    const messages = await consumer.consume();

    (async () => {
      for await (const m of messages) {
        try {
          const result = await onMessage(m.data);
          if (result === "retry") m.nak();
          else m.ack();
        } catch (err) {
          m.nak();
          const e = err instanceof Error ? err : new Error(String(err));
          console.error("[NatsBroker.consumeJetStream] message failed", {
            subject,
            durableName,
            message: e.message,
            stack: e.stack,
          });
        }
      }
    })().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[NatsBroker.consumeJetStream] loop crashed", { subject, durableName, message: e.message, stack: e.stack });
    });

    return {
      unsubscribe: () => {
        void messages.close();
      },
    };
  }

  async subscribeWithAck(params: {
    subject: string;
    consumerId: string;
    dedupe: DedupeStore;
    onMessage: MessageHandler;
    maxPoisonAttempts?: number;
    /** Optional ingress authorizer; when set, envelopes are authorized before delivery
     *  (wire @murmurv2/federation authorizeInbound here behind MURMUR_ENFORCE_AUTH). */
    authorize?: InboundAuthorizer;
    /** Signs ACKs with the receiving agent's long-term signing key. */
    signAck?: AckSigner;
  }): Promise<BrokerSubscription> {
    await this.connect();

    if (this.js) {
      return this.consumeJetStream(params.subject, params.consumerId, (data) => this.processEnvelopeFrame(data, params));
    }

    const sub = this.nc!.subscribe(params.subject);

    (async () => {
      for await (const m of sub) {
        await this.processEnvelopeFrame(m.data, params);
      }
    })().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[NatsBroker.subscribeWithAck] loop crashed", { message: e.message, stack: e.stack });
    });

    return sub;
  }

  /**
   * Read-only real-time tap on a subject. Plain core subscription — no queue
   * group, no ACK publish, no dedupe, no JetStream consumer. A plain subscriber
   * still receives `js.publish`'d messages in real time, so this works whether
   * or not JetStream is enabled, and it never steals delivery from the durable
   * daemon consumer (which uses its own consumerId / queue semantics).
   *
   * Intended as a wake-signal source: `onEnvelope` receives the decoded
   * envelope METADATA only (conversationId, senderAgentId, msgId). It does NOT
   * decrypt the payload — decryption stays the daemon's responsibility. Malformed
   * frames are ignored (best-effort signal, not a delivery path).
   */
  async subscribeRaw(
    subject: string,
    onEnvelope: (envelope: EnvelopeV1) => void,
  ): Promise<BrokerSubscription> {
    await this.connect();
    const sub = this.nc!.subscribe(subject);

    (async () => {
      for await (const m of sub) {
        try {
          const decoded = JSON.parse(this.sc.decode(m.data));
          if (isEnvelopeV1(decoded)) onEnvelope(decoded);
        } catch {
          // ignore malformed frames — read-only wake signal, not a delivery path
        }
      }
    })().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[NatsBroker.subscribeRaw] loop crashed", { subject, message: e.message, stack: e.stack });
    });

    return sub;
  }

  /**
   * Broadcast a signed presence frame for agent discovery. Presence is PUBLIC
   * (public keys + capabilities), so it is published in the clear — not encrypted
   * like a message envelope. Integrity/authorship come from the frame signature.
   */
  async announcePresence(subject: string, signed: SignedPresenceFrameV1): Promise<void> {
    await this.connect();
    const payload = this.sc.encode(JSON.stringify(signed));
    if (this.js) {
      await this.js.publish(subject, payload);
      return;
    }
    this.nc!.publish(subject, payload);
  }

  /**
   * Listen for signed presence frames on a discovery subject. Plain read-only
   * subscription — no ACK, no dedupe, no JetStream consumer. Signature
   * verification + registry folding are the caller's job (see
   * `observeSignedPresence` in @murmurv2/core). Malformed frames are dropped.
   */
  async subscribePresence(
    subject: string,
    onPresence: (signed: SignedPresenceFrameV1) => void,
  ): Promise<BrokerSubscription> {
    await this.connect();
    const sub = this.nc!.subscribe(subject);

    (async () => {
      for await (const m of sub) {
        try {
          const decoded = JSON.parse(this.sc.decode(m.data));
          if (isSignedPresenceFrameV1(decoded)) onPresence(decoded);
        } catch {
          // ignore malformed presence frames — discovery is best-effort
        }
      }
    })().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[NatsBroker.subscribePresence] loop crashed", { subject, message: e.message, stack: e.stack });
    });

    return sub;
  }

  async startAckCorrelation(params: {
    outbox: OutboxStore;
    /** Durable replay protection. Omit only where a restart cannot happen — without it
     *  the in-memory fallback forgets every nonce when the process dies. */
    ackReceipts?: AckReceiptStore;
    ackSubject: string;
    consumerId?: string;
    verifyAck?: AckVerifier;
    requireSignedAcks?: boolean;
    maxAckAgeMs?: number;
    maxFutureSkewMs?: number;
    onInvalidAck?: (event: InvalidAckEvent) => void;
  }): Promise<BrokerSubscription> {
    await this.connect();

    if (this.js) {
      const consumerId = params.consumerId ?? `${params.ackSubject.replaceAll(".", "-")}-consumer`;
      return this.consumeJetStream(params.ackSubject, consumerId, async (data) => {
        await this.processAckFrame(data, params);
      });
    }

    const sub = this.nc!.subscribe(params.ackSubject);

    (async () => {
      for await (const m of sub) {
        await this.processAckFrame(m.data, params);
      }
    })().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[NatsBroker.startAckCorrelation] loop crashed", { message: e.message, stack: e.stack });
    });

    return sub;
  }

  private invalidAck(
    params: {
      onInvalidAck?: (event: InvalidAckEvent) => void;
    },
    reason: string,
    candidate?: Partial<SignedAckV1>,
  ): void {
    this.invalidAckCounts.set(reason, (this.invalidAckCounts.get(reason) ?? 0) + 1);
    const event = {
      reason,
      ...(typeof candidate?.msgId === "string" ? { msgId: candidate.msgId } : {}),
      ...(typeof candidate?.senderAgentId === "string" ? { senderAgentId: candidate.senderAgentId } : {}),
    };
    console.warn("[NatsBroker.security] invalid ACK rejected", event);
    params.onInvalidAck?.(event);
  }

  /**
   * Claim an ACK nonce once. Prefers the durable store; the in-memory set is a fallback
   * that does NOT survive a restart — see AckReceiptStore in @murmurv2/core.
   */
  private async claimAckNonce(
    store: AckReceiptStore | undefined,
    senderAgentId: string,
    nonce: string,
  ): Promise<boolean> {
    if (store) return store.claimAckNonce(senderAgentId, nonce);
    return this.rememberAckNonceInMemory(`${senderAgentId}:${nonce}`);
  }

  private rememberAckNonceInMemory(nonce: string): boolean {
    if (this.seenAckNonces.has(nonce)) return false;
    this.seenAckNonces.add(nonce);
    if (this.seenAckNonces.size > 10_000) {
      const oldest = this.seenAckNonces.values().next();
      if (!oldest.done) this.seenAckNonces.delete(oldest.value);
    }
    return true;
  }

  private async processAckFrame(
    data: Uint8Array,
    params: {
      outbox: OutboxStore;
      ackReceipts?: AckReceiptStore;
      verifyAck?: AckVerifier;
      requireSignedAcks?: boolean;
      maxAckAgeMs?: number;
      maxFutureSkewMs?: number;
      onInvalidAck?: (event: InvalidAckEvent) => void;
    },
  ): Promise<void> {
    try {
      const decoded = JSON.parse(this.sc.decode(data)) as unknown;

      if (!isSignedAckV1(decoded)) {
        const legacy = decoded as Partial<AckV1>;
        if (params.requireSignedAcks === true) {
          this.invalidAck(params, "unsigned-or-malformed", {
            msgId: typeof legacy?.msgId === "string" ? legacy.msgId : undefined,
          });
          return;
        }
        if (typeof legacy?.msgId !== "string" || legacy.msgId.length === 0) return;
        if (legacy.status === "ack") {
          await params.outbox.markAcked(legacy.msgId);
        } else if (legacy.status === "nack") {
          await params.outbox.markFailed(
            legacy.msgId,
            legacy.reason ?? "nack",
            new Date().toISOString(),
          );
        }
        return;
      }

      const record = await params.outbox.getOutboxRecord(decoded.msgId);
      if (!record) {
        this.invalidAck(params, "unknown-message", decoded);
        return;
      }
      // 'pending' is in flight too: the peer can acknowledge between publish() and
      // markSent(). Rejecting that ACK leaves the row to time out into a spurious retry.
      if (record.status !== "sent" && record.status !== "pending") {
        this.invalidAck(params, "message-not-in-flight", decoded);
        return;
      }
      if (decoded.messageDigest !== envelopeDigest(record.envelope)) {
        this.invalidAck(params, "message-digest-mismatch", decoded);
        return;
      }
      if (decoded.conversationId !== record.envelope.conversationId) {
        this.invalidAck(params, "conversation-mismatch", decoded);
        return;
      }
      if (decoded.recipientAgentId !== record.envelope.senderAgentId) {
        this.invalidAck(params, "recipient-mismatch", decoded);
        return;
      }
      if (!record.envelope.recipients.includes(decoded.senderAgentId)) {
        this.invalidAck(params, "unexpected-peer", decoded);
        return;
      }

      const atMs = Date.parse(decoded.at);
      const now = Date.now();
      const maxAckAgeMs = params.maxAckAgeMs ?? 5 * 60_000;
      const maxFutureSkewMs = params.maxFutureSkewMs ?? 30_000;
      if (atMs < now - maxAckAgeMs || atMs > now + maxFutureSkewMs) {
        this.invalidAck(params, "timestamp-out-of-window", decoded);
        return;
      }
      if (!params.verifyAck || !(await params.verifyAck(decoded))) {
        this.invalidAck(params, "signature-invalid", decoded);
        return;
      }
      if (!(await this.claimAckNonce(params.ackReceipts, decoded.senderAgentId, decoded.nonce))) {
        this.invalidAck(params, "nonce-replay", decoded);
        return;
      }

      if (decoded.status === "ack") {
        const result = await params.outbox.applyAckTransition(decoded.msgId, "ack");
        if (result !== "applied") this.invalidAck(params, `transition-${result}`, decoded);
        return;
      }

      const result = await params.outbox.applyAckTransition(
        decoded.msgId,
        "nack",
        decoded.reason ?? "nack",
        new Date().toISOString(),
      );
      if (result !== "applied") this.invalidAck(params, `transition-${result}`, decoded);
    } catch {
      this.invalidAck(params, "processing-error");
    }
  }

  async startJetStreamAdvisoryDlq(params: {
    outbox: OutboxStore;
  }): Promise<BrokerSubscription> {
    await this.connect();
    if (!this.nc) throw new Error("nats-connection-unavailable");
    if (!this.jsm) throw new Error("jetstream-manager-unavailable");

    const stream = this.streamName();
    const subjects = [
      `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.*`,
      `$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${stream}.*`,
    ];
    const subs = subjects.map((subject) => this.nc!.subscribe(subject));

    for (const sub of subs) {
      (async () => {
        for await (const m of sub) {
          await this.processJetStreamAdvisoryFrame(m.data, params.outbox);
        }
      })().catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error("[NatsBroker.startJetStreamAdvisoryDlq] loop crashed", {
          message: e.message,
          stack: e.stack,
        });
      });
    }

    return {
      unsubscribe: () => {
        for (const sub of subs) sub.unsubscribe();
      },
    };
  }

  private async processJetStreamAdvisoryFrame(data: Uint8Array, outbox: OutboxStore): Promise<void> {
    if (!this.jsm) throw new Error("jetstream-manager-unavailable");

    try {
      const advisory = JSON.parse(this.sc.decode(data)) as JetStreamConsumerAdvisory;
      const advisoryKind = this.jetStreamAdvisoryKind(advisory);
      if (!advisoryKind) return;
      if (advisory.stream !== this.streamName()) return;
      const streamSeqRaw = advisory.stream_seq;
      if (typeof streamSeqRaw !== "number" || !Number.isFinite(streamSeqRaw) || streamSeqRaw <= 0) return;

      const streamSeq = Math.trunc(streamSeqRaw);
      const stored = await this.jsm.streams.getMessage(advisory.stream, { seq: streamSeq });
      const envelope = JSON.parse(this.sc.decode(stored.data));
      if (!isEnvelopeV1(envelope)) return;

      await outbox.markDlq(envelope.msgId, this.jetStreamAdvisoryReason(advisoryKind, advisory, streamSeq));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[NatsBroker.startJetStreamAdvisoryDlq] malformed advisory frame", {
        message: e.message,
        stack: e.stack,
        raw: this.sc.decode(data),
      });
    }
  }

  private jetStreamAdvisoryKind(advisory: JetStreamConsumerAdvisory): "max_deliver" | "terminated" | undefined {
    if (advisory.type === "io.nats.jetstream.advisory.v1.max_deliver") return "max_deliver";
    if (advisory.type === "io.nats.jetstream.advisory.v1.terminated") return "terminated";
    return undefined;
  }

  private jetStreamAdvisoryReason(
    kind: "max_deliver" | "terminated",
    advisory: JetStreamConsumerAdvisory,
    streamSeq: number,
  ): string {
    const consumer = advisory.consumer ?? "unknown-consumer";
    const deliveriesRaw = advisory.deliveries;
    const deliveries = typeof deliveriesRaw === "number" && Number.isFinite(deliveriesRaw)
      ? `:deliveries=${Math.trunc(deliveriesRaw)}`
      : "";
    return `jetstream-advisory:${kind}:${consumer}${deliveries}:stream_seq=${streamSeq}`;
  }

  /**
   * Basic outbox worker:
   * - picks due records
   * - publishes
   * - marks sent/failed/dlq
   * - ACK correlation handled via startAckCorrelation(...)
   */
  async flushOutbox(params: {
    outbox: OutboxStore;
    maxAttempts?: number;
    batchSize?: number;
    baseBackoffMs?: number;
    jitterRatio?: number;
    ackTimeoutMs?: number;
    ackWindow?: AckWindowConfig;
    policy?: SecurityPolicy;
  }): Promise<void> {
    const maxAttempts = params.maxAttempts ?? 5;
    if (params.ackTimeoutMs && params.outbox.requeueStaleSent) {
      await params.outbox.requeueStaleSent(params.ackTimeoutMs);
    }
    const due = await params.outbox.claimDue(params.batchSize ?? 50);
    const inFlight = params.ackWindow && params.outbox.listInFlight
      ? await params.outbox.listInFlight()
      : [];
    let inFlightChunks = inFlight.length;
    let inFlightBytes = inFlight.reduce((sum, rec) => sum + estimateBase64DecodedBytes(rec.envelope.payloadCiphertext), 0);

    for (const rec of due) {
      const nextChunkBytes = Math.max(1, estimateBase64DecodedBytes(rec.envelope.payloadCiphertext));
      if (params.ackWindow && !streamBackpressureAllowsSend({
        inFlightChunks,
        inFlightBytes,
        nextChunkBytes,
        maxInFlightChunks: params.ackWindow.maxInFlightChunks,
        maxInFlightBytes: params.ackWindow.maxInFlightBytes,
      })) {
        break;
      }

      try {
        await this.publish(rec.subject, rec.envelope, params.policy);
        await params.outbox.markSent(rec.msgId, rec.version);
        if (params.ackWindow) {
          inFlightChunks += 1;
          inFlightBytes += nextChunkBytes;
        }
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
