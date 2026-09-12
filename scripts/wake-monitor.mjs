import { execFile } from "node:child_process";

const ensureObject = (value) => (value && typeof value === "object" ? value : {});
const DEFAULT_WAKE_MAX_ATTEMPTS = 5;
const DEFAULT_WAKE_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_WAKE_RETRY_BACKOFF_MAX_MS = 10 * 60_000;
const DEFAULT_WAKE_CONCURRENCY = 4;
const validMode = (mode) => mode === "stateless" || mode === "codex_app_server";

export const normalizeWakeConfig = (config = {}) => {
  const wake = ensureObject(config.wake);
  const dedup = ensureObject(wake.dedup);
  const loopBreaker = ensureObject(wake.loopBreaker);
  const retry = ensureObject(wake.retry);
  const peers = Object.fromEntries(
    Object.entries(ensureObject(wake.peers)).map(([agentId, peer]) => {
      const value = ensureObject(peer);
      const normalized = {
        mode: validMode(value.mode) ? value.mode : undefined,
        socketPath: typeof value.socketPath === "string" && value.socketPath.trim() ? value.socketPath.trim() : undefined,
        threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : undefined,
      };
      if (typeof value.cwd === "string" && value.cwd.trim()) normalized.cwd = value.cwd.trim();
      if (typeof value.model === "string" && value.model.trim()) normalized.model = value.model.trim();
      if (typeof value.murmurRoot === "string" && value.murmurRoot.trim()) normalized.murmurRoot = value.murmurRoot.trim();
      if (typeof value.dataDir === "string" && value.dataDir.trim()) normalized.dataDir = value.dataDir.trim();
      if (typeof value.storePath === "string" && value.storePath.trim()) normalized.storePath = value.storePath.trim();
      if (value.relayFinalToMurmur === true) normalized.relayFinalToMurmur = true;
      // Without this the injector's `peer.resume === false` opt-out is unreachable
      // from a real config: normalization used to drop the field entirely.
      if (typeof value.resume === "boolean") normalized.resume = value.resume;
      // Same story for baseInstructions: the channel binding resolver falls back to
      // `peer.baseInstructions`, so dropping it here makes per-peer role instructions
      // impossible to configure — the only remaining lever is `personaId`, which Codex
      // rejects for anything outside its own `none|friendly|pragmatic` enum.
      if (typeof value.baseInstructions === "string" && value.baseInstructions.trim()) {
        normalized.baseInstructions = value.baseInstructions;
      }
      if (Number.isFinite(Number(value.replyTimeoutMs))) normalized.replyTimeoutMs = Number(value.replyTimeoutMs);
      return [agentId, normalized];
    }),
  );
  return {
    enabled: wake.enabled !== false,
    mode: validMode(wake.mode) ? wake.mode : "stateless",
    peers,
    auditHook: typeof wake.auditHook === "string" && wake.auditHook.trim() ? wake.auditHook.trim() : null,
    dedup: {
      cooldownMs: Number.isFinite(Number(dedup.cooldownMs)) ? Number(dedup.cooldownMs) : 300000,
    },
    loopBreaker: {
      maxWakes: Number.isFinite(Number(loopBreaker.maxWakes)) ? Number(loopBreaker.maxWakes) : 5,
      windowMs: Number.isFinite(Number(loopBreaker.windowMs)) ? Number(loopBreaker.windowMs) : 60000,
    },
    // #107 — how many wakes may run at once. Lanes are keyed per peer/conversation, so
    // this bounds parallelism across conversations; within one, order is kept.
    concurrency: Number.isFinite(Number(wake.concurrency)) && Number(wake.concurrency) >= 1 ? Math.floor(Number(wake.concurrency)) : DEFAULT_WAKE_CONCURRENCY,
    // #105 — how long a delivery keeps being retried before it is dead-lettered.
    retry: {
      maxAttempts: Number.isFinite(Number(retry.maxAttempts)) ? Number(retry.maxAttempts) : DEFAULT_WAKE_MAX_ATTEMPTS,
      backoffMs: Number.isFinite(Number(retry.backoffMs)) ? Number(retry.backoffMs) : DEFAULT_WAKE_RETRY_BACKOFF_MS,
      backoffMaxMs: Number.isFinite(Number(retry.backoffMaxMs)) ? Number(retry.backoffMaxMs) : DEFAULT_WAKE_RETRY_BACKOFF_MAX_MS,
    },
  };
};

export const createShellHook = ({ command, timeoutMs = 10000, baseEnv = process.env, log = () => {} }) => {
  if (!command) return null;
  return (payload) => new Promise((resolve) => {
    const env = {
      ...baseEnv,
      MURMUR_FROM: payload.from,
      MURMUR_TEXT: payload.text,
      MURMUR_MSG_ID: payload.msgId,
      MURMUR_CONVERSATION_ID: payload.conversationId,
      MURMUR_CHANNEL_ID: payload.channelId || "",
      MURMUR_SENDER_MEMBER_ID: payload.senderMemberId || "",
      MURMUR_ADDRESSEE_MEMBER_ID: payload.addresseeMemberId || "",
      ...(payload.env || {}),
    };
    execFile("sh", ["-c", command], { env, timeout: timeoutMs }, (err) => {
      if (err) log("warn", "wake hook failed", { error: err.message, msgId: payload.msgId });
      resolve();
    });
  });
};

export const createAuditShellHook = ({ command, timeoutMs = 10000, baseEnv = process.env, log = () => {} }) => {
  if (!command) return null;
  return (payload) => new Promise((resolve) => {
    const env = {
      ...baseEnv,
      MURMUR_FROM: payload.from,
      MURMUR_TEXT: payload.text,
      MURMUR_MSG_ID: payload.msgId,
      MURMUR_CONVERSATION_ID: payload.conversationId,
      MURMUR_CHANNEL_ID: payload.channelId || "",
      MURMUR_SENDER_MEMBER_ID: payload.senderMemberId || "",
      MURMUR_ADDRESSEE_MEMBER_ID: payload.addresseeMemberId || "",
      ...(payload.env || {}),
    };
    execFile("sh", ["-c", command], { env, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        log("warn", "wake audit hook failed", { error: err.message, msgId: payload.msgId });
        resolve("deny");
        return;
      }
      const verdict = String(stdout || "").split(/\r?\n/, 1)[0]?.trim();
      resolve(verdict === "deny" || verdict === "require_approval" || verdict === "allow" ? verdict : "deny");
    });
  });
};

/** Exponential backoff for wake retries: base·2^(attempt−1), capped. */
export const wakeRetryBackoffMs = (attempt, baseMs = DEFAULT_WAKE_RETRY_BACKOFF_MS, maxMs = DEFAULT_WAKE_RETRY_BACKOFF_MAX_MS) =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(attempt || 1) - 1));

/** Rebuild the hook payload from a stored inbound row (backlog and retries come from the table). */
export const payloadFromDeliveryRow = (row) => ({
  from: row.sender,
  text: row.text,
  msgId: row.msgId,
  conversationId: row.conversationId,
  channelId: row.channelId,
  senderMemberId: row.senderMemberId,
  addresseeMemberId: row.addresseeMemberId,
  wakeEligible: row.wakeEligible === undefined ? true : Boolean(row.wakeEligible),
  ts: row.createdAt,
  cursor: Number(row.rowid),
});

export class WakeMonitor {
  constructor(options = {}) {
    const wakeConfig = normalizeWakeConfig({ wake: options });
    this.enabled = options.enabled ?? wakeConfig.enabled;
    this.mode = options.mode ?? wakeConfig.mode;
    this.peers = options.peers ?? wakeConfig.peers;
    this.cooldownMs = options.dedup?.cooldownMs ?? wakeConfig.dedup.cooldownMs;
    this.loopBreaker = {
      maxWakes: options.loopBreaker?.maxWakes ?? wakeConfig.loopBreaker.maxWakes,
      windowMs: options.loopBreaker?.windowMs ?? wakeConfig.loopBreaker.windowMs,
    };
    this.hook = options.hook || null;
    this.injector = options.injector || null;
    this.auditHook = options.auditHook || null;
    this.leaseGate = options.leaseGate || null;
    this.notify = options.notify || null;
    this.loadBacklogAfter = options.loadBacklogAfter || null;
    // #105 — durable delivery state (a SQLiteMessageStore or anything with the same
    // claimWake / settleWake / listOpenWakes / wakeCursor / recoverInflightWakes shape).
    // With it, the table is the queue: the cursor is derived from settled rows, a failed
    // wake is retried under the same delivery id, and a restart resumes from where the
    // rows say it stopped. Without it the monitor behaves exactly as before.
    this.deliveries = options.deliveries || null;
    this.maxAttempts = Number.isFinite(Number(options.maxAttempts)) ? Number(options.maxAttempts) : wakeConfig.retry.maxAttempts;
    this.retryBackoffMs = Number.isFinite(Number(options.retryBackoffMs)) ? Number(options.retryBackoffMs) : wakeConfig.retry.backoffMs;
    this.retryBackoffMaxMs = Number.isFinite(Number(options.retryBackoffMaxMs)) ? Number(options.retryBackoffMaxMs) : wakeConfig.retry.backoffMaxMs;
    this.recoveredInflight = false;
    this.concurrency = Number.isFinite(Number(options.concurrency)) && Number(options.concurrency) >= 1
      ? Math.floor(Number(options.concurrency))
      : wakeConfig.concurrency;
    this.dispatchSignal = null;
    this.now = options.now || (() => Date.now());
    this.log = options.log || (() => {});
    this.seen = new Map();
    this.senderWindows = new Map();
    this.suspendedSenders = new Map();
    this.queue = [];
    this.queuedKeys = new Set();
    this.processing = false;
    this.cursor = Number.isFinite(Number(options.initialCursor)) ? Number(options.initialCursor) : 0;
  }

  async onInbound(payload) {
    if (!this.enabled) return;
    this.enqueue(payload);
    await this.drain();
  }

  enqueue(payload) {
    if (!payload?.msgId) return;
    const key = this.keyFor(payload);
    if (this.queuedKeys.has(key)) return;
    this.queuedKeys.add(key);
    this.queue.push(payload);
    this.kickDispatcher();
  }

  nowIso() {
    return new Date(this.now()).toISOString();
  }

  /** Wake a drain that is parked on busy lanes: something new is in the queue. */
  kickDispatcher() {
    const signal = this.dispatchSignal;
    this.dispatchSignal = null;
    signal?.resolve();
  }

  /**
   * #107 — lanes instead of one line. Every queued payload belongs to a lane (see
   * `laneKeyFor`); at most `concurrency` lanes run at once and a lane never runs two
   * payloads together, so a long turn for one peer no longer holds a short question for
   * another, while messages within one conversation keep their order.
   */
  async runLanes() {
    const active = new Map();
    while (this.queue.length > 0 || active.size > 0) {
      if (active.size < this.concurrency) {
        const index = this.queue.findIndex((payload) => !active.has(this.laneKeyFor(payload)));
        if (index >= 0) {
          const [payload] = this.queue.splice(index, 1);
          this.queuedKeys.delete(this.keyFor(payload));
          const lane = this.laneKeyFor(payload);
          const run = this.processPayload(payload)
            .catch((err) => {
              const e = err instanceof Error ? err : new Error(String(err));
              this.log("error", "WakeMonitor lane crashed", { error: e.message, msgId: payload.msgId, lane });
            })
            .then(() => { active.delete(lane); });
          active.set(lane, run);
          continue;
        }
      }
      if (active.size === 0) break;
      const parked = new Promise((resolve) => { this.dispatchSignal = { resolve }; });
      await Promise.race([...active.values(), parked]);
      this.dispatchSignal = null;
    }
  }

  async drain() {
    if (this.processing) {
      this.kickDispatcher();
      return;
    }
    this.processing = true;
    try {
      if (this.deliveries && !this.recoveredInflight) {
        this.recoveredInflight = true;
        const recovered = await this.deliveries.recoverInflightWakes?.({ now: this.nowIso() });
        if (recovered) this.log("warn", "WakeMonitor recovered in-flight deliveries from a previous process", { count: recovered });
        this.cursor = await this.deliveries.wakeCursor();
      }
      const offeredThisDrain = new Set();
      while (true) {
        await this.runLanes();

        let backlog;
        if (this.loadBacklogAfter) {
          backlog = await this.loadBacklogAfter(this.cursor);
        } else if (this.deliveries) {
          const rows = await this.deliveries.listOpenWakes({ now: this.nowIso() });
          // A row that came back after being processed in this very pass is not due
          // again (its retry lies in the future); refusing it here keeps the loop finite.
          backlog = rows.filter((row) => !offeredThisDrain.has(row.msgId)).map(payloadFromDeliveryRow);
          for (const row of rows) offeredThisDrain.add(row.msgId);
        }
        if (!Array.isArray(backlog) || backlog.length === 0) break;
        for (const payload of backlog) this.enqueue(payload);
      }
    } finally {
      this.processing = false;
    }
  }

  async processPayload(payload) {
    const durable = Boolean(this.deliveries);
    let claim = null;
    if (durable) {
      claim = await this.deliveries.claimWake(payload.msgId, { now: this.nowIso() });
      if (!claim.claimed) {
        // Handled, muted, dead-lettered, in flight elsewhere, or not yet due: whichever
        // it is, this copy is not new work. The delivery itself already succeeded.
        this.log("info", "WakeMonitor delivery already claimed", {
          msgId: payload.msgId,
          conversationId: payload.conversationId,
          status: claim.status ?? null,
        });
        await this.advanceCursor(payload);
        return;
      }
      payload.attempt = claim.attempts;
    }
    const settle = async (status, extra = {}) => {
      if (durable) await this.deliveries.settleWake(payload.msgId, { status, ...extra, now: this.nowIso() });
      await this.advanceCursor(payload);
    };

    // `wakeEligible` is a local receive-time authorization decision persisted by
    // the daemon. Check it at the shared effect boundary so delayed backlog rows
    // cannot bypass the immediate channel-addressing gate. Missing means legacy.
    if (payload.wakeEligible === false) {
      await settle("muted", { error: "receive-time-ineligible" });
      this.log("info", "WakeMonitor policy mute", {
        msgId: payload.msgId,
        conversationId: payload.conversationId,
        reason: "receive-time-ineligible",
      });
      return;
    }
    const key = this.keyFor(payload);
    const now = this.now();
    this.pruneSeen(now);
    if (!durable) {
      // Without durable state the in-memory cooldown is the only duplicate guard. With
      // it, the claim above already refused every copy that is not a due retry.
      const lastWakeAt = this.seen.get(key);
      if (lastWakeAt !== undefined && now - lastWakeAt < this.cooldownMs) {
        await this.advanceCursor(payload);
        this.log("info", "WakeMonitor duplicate dropped", { msgId: payload.msgId, conversationId: payload.conversationId });
        return;
      }
    }

    this.seen.set(key, now);
    if (await this.isLoopBreakerBlocked(payload, now)) {
      await settle("muted", { error: "loop-breaker" });
      return;
    }

    const verdict = await this.audit(payload);
    if (verdict === "deny") {
      this.log("warn", "WakeMonitor audit denied wake", { msgId: payload.msgId, conversationId: payload.conversationId, from: payload.from });
      await settle("muted", { error: "audit-deny" });
      return;
    }
    if (verdict === "require_approval") {
      await this.notify?.(payload, "require_approval");
      this.log("warn", "WakeMonitor audit requires approval", { msgId: payload.msgId, conversationId: payload.conversationId, from: payload.from });
      await settle("muted", { error: "audit-require-approval" });
      return;
    }

    // Scoped-channels lease gate (#82): the native daemon wake is a fallback owner.
    // If a live chat session already owns this conversation, mute the native wake so it
    // does not spawn a competing thread; otherwise claim and route as the cold-wake owner.
    if (this.leaseGate) {
      let decision;
      try {
        decision = await this.leaseGate(payload, this.peerFor(payload));
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        decision = { allow: false, reason: `lease-gate-error:${e.message}` };
      }
      if (!decision || decision.allow !== true) {
        this.log("info", "WakeMonitor lease mute (non-owner)", {
          msgId: payload.msgId,
          conversationId: payload.conversationId,
          ownerSessionId: decision?.ownerSessionId ?? null,
          reason: decision?.reason ?? "non-owner",
        });
        await settle("muted", { error: `lease:${decision?.reason ?? "non-owner"}` });
        return;
      }
      payload.leaseToken = decision.token ?? null;
    }

    let result;
    try {
      const peer = this.peerFor(payload);
      if (peer.mode === "codex_app_server") {
        if (!this.injector) throw new Error(`wake-native-injector-missing:${payload.from}`);
        result = await this.injector(payload, peer);
        this.log("info", "WakeMonitor native wake completed", { msgId: payload.msgId, conversationId: payload.conversationId, mode: peer.mode });
      } else {
        if (this.hook) result = await this.hook(payload);
        this.log("info", "WakeMonitor hook completed", { msgId: payload.msgId, conversationId: payload.conversationId });
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.log("warn", "WakeMonitor hook error", { error: e.message, msgId: payload.msgId, attempt: claim?.attempts ?? null });
      if (!durable) {
        // Legacy behaviour: the failure is logged and the cursor moves on.
        await this.advanceCursor(payload);
        return;
      }
      const attempts = claim.attempts;
      const retryable = e.retryable !== false && attempts < this.maxAttempts;
      if (retryable) {
        const delayMs = wakeRetryBackoffMs(attempts, this.retryBackoffMs, this.retryBackoffMaxMs);
        await settle("failed", { error: e.message, nextAttemptAt: new Date(this.now() + delayMs).toISOString() });
        this.log("warn", "WakeMonitor wake scheduled for retry", { msgId: payload.msgId, attempt: attempts, retryInMs: delayMs });
        return;
      }
      // Out of attempts, or the error says a retry cannot help: settle visibly. The
      // delivery is done with — the cursor may pass it — but somebody gets told.
      await settle("dlq", { error: e.message });
      await this.notify?.(payload, "wake-dlq");
      this.log("error", "WakeMonitor wake dead-lettered", { msgId: payload.msgId, attempts, error: e.message, retryable: e.retryable !== false });
      return;
    }
    const replyMsgId = result?.replyMsgId ?? result?.relay?.msgId ?? undefined;
    await settle("handled", replyMsgId ? { replyMsgId } : {});
  }

  pruneSeen(now = this.now()) {
    for (const [key, wokeAt] of this.seen.entries()) {
      if (now - wokeAt >= this.cooldownMs) this.seen.delete(key);
    }
  }

  async isLoopBreakerBlocked(payload, now) {
    const sender = payload.from || "unknown";
    const suspendedUntil = this.suspendedSenders.get(sender);
    if (suspendedUntil !== undefined) {
      if (now < suspendedUntil) {
        this.suspendedSenders.set(sender, now + this.loopBreaker.windowMs);
        await this.notify?.(payload, "loop-breaker");
        this.log("warn", "WakeMonitor loop-breaker suspended wake", { sender, msgId: payload.msgId, suspendedUntil: this.suspendedSenders.get(sender) });
        return true;
      }
      this.suspendedSenders.delete(sender);
    }

    const since = now - this.loopBreaker.windowMs;
    const window = (this.senderWindows.get(sender) || []).filter((ts) => ts > since);
    if (window.length >= this.loopBreaker.maxWakes) {
      this.suspendedSenders.set(sender, now + this.loopBreaker.windowMs);
      this.senderWindows.set(sender, window);
      await this.notify?.(payload, "loop-breaker");
      this.log("warn", "WakeMonitor loop-breaker tripped", { sender, count: window.length + 1, msgId: payload.msgId });
      return true;
    }

    window.push(now);
    this.senderWindows.set(sender, window);
    return false;
  }

  async audit(payload) {
    if (!this.auditHook) return "allow";
    const verdict = await this.auditHook(payload);
    return verdict === "allow" || verdict === "require_approval" || verdict === "deny" ? verdict : "deny";
  }

  async advanceCursor(payload) {
    if (this.deliveries) {
      // The cursor is not a counter we bump: it is the highest contiguous settled
      // delivery, read back from the rows. A gap holds it; nothing skips it.
      this.cursor = await this.deliveries.wakeCursor();
      return;
    }
    const cursor = Number(payload?.cursor);
    if (Number.isFinite(cursor) && cursor > this.cursor) this.cursor = cursor;
  }

  keyFor(payload) {
    return payload.msgId;
  }

  /**
   * Which payloads must never run together. A Codex peer pinned to one static thread
   * takes one turn at a time whatever the conversation; everything else is serialised
   * per (peer, conversation), which is also how #108 scopes Codex threads.
   */
  laneKeyFor(payload) {
    const peer = this.peerFor(payload);
    if (peer.mode === "codex_app_server" && peer.threadId) return `peer:${payload.from}`;
    return `conv:${payload.from}|${payload.conversationId ?? ""}`;
  }

  peerFor(payload) {
    const peer = ensureObject(this.peers?.[payload.from]);
    return {
      ...peer,
      mode: validMode(peer.mode) ? peer.mode : this.mode,
    };
  }
}
