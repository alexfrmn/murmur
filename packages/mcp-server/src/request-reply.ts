import type { EnvelopeV1, LocalMessageRecord, OutboxStatus } from "@murmurv2/core";

// Leave room below desktop hosts' common 60-second tool limit. A larger caller
// timeout must not turn a healthy but slower peer into a host-level tool error.
export const MAX_REQUEST_WAIT_MS = 45_000;
export function requestTiming(args: Record<string, unknown>) {
  const number = (key: string, fallback: number, minimum: number) => {
    const value = args[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${key} must be an integer >= ${minimum}`);
    }
    return value;
  };
  const requestedTimeoutMs = number("timeout_ms", MAX_REQUEST_WAIT_MS, 1);
  const timeoutMs = Math.min(requestedTimeoutMs, MAX_REQUEST_WAIT_MS);
  return { requestedTimeoutMs, timeoutMs,
    pollMs: Math.min(number("poll_interval_ms", 10_000, 1), timeoutMs),
    graceMs: Math.min(number("grace_ms", 250, 0), timeoutMs) };
}

export function requestDelivery(status: OutboxStatus | undefined) {
  return { status: status === "acked" ? "delivered" : status === "dlq" ? "failed" : status ? "pending" : "unknown",
    acknowledged: status === "acked", outboxStatus: status ?? "unknown" };
}

interface SignalSubscription { unsubscribe(): void | Promise<void>; }
interface SignalBroker {
  subscribeRaw(subject: string, onEnvelope: (envelope: EnvelopeV1) => void): Promise<SignalSubscription>;
}

/** Optional acceleration never blocks store polling or completion, even while
 * connecting. A subscription that attaches after close is immediately released. */
export function createReplySignalTap(connect: () => Promise<SignalBroker | null>, subjects: string[],
  onEnvelope: (envelope: EnvelopeV1) => void) {
  let closed = false, attached = false;
  const subscriptions: SignalSubscription[] = [];
  const release = (sub: SignalSubscription) => {
    try { void Promise.resolve(sub.unsubscribe()).catch(() => {}); } catch { /* optional tap */ }
  };
  void Promise.resolve().then(connect).then(async broker => {
    if (!broker || closed) return;
    await Promise.all(subjects.map(async subject => {
      try {
        const sub = await broker.subscribeRaw(subject, envelope => { if (!closed) onEnvelope(envelope); });
        if (closed) release(sub);
        else { attached = true; subscriptions.push(sub); }
      } catch { /* Store polling remains the durable fallback. */ }
    }));
  }).catch(() => {});
  return { hasAttached: () => attached, close: () => { closed = true; subscriptions.splice(0).forEach(release); } };
}

/**
 * Pure wait-loop for the request/reply ("native-request-reply") flow.
 *
 * Design B (locked with CODEX-VOLT):
 * - The outbox stays the source of truth: sending happens elsewhere, this only WAITS.
 * - Store polling is the durable fallback and ALWAYS runs, so a reply is found even
 *   when no live wake signal is available (NATS down / `onSignal` omitted).
 * - An optional `onSignal` source (a read-only NATS tap on the agent's own subject)
 *   accelerates the wait: when a matching envelope arrives we re-check the store
 *   immediately instead of waiting out the poll interval. The signal NEVER carries
 *   the reply itself — decryption + persistence stay the daemon's job — it only nudges
 *   us to re-poll the store the daemon writes into.
 *
 * Lost-wakeup safety: the wake promise is armed BEFORE each store check, so a signal
 * that fires between the check and the race still short-circuits the wait.
 */
export interface ReplyWaiterDeps {
  /** Return the reply record if one has arrived, else null. */
  checkStore: () => Promise<LocalMessageRecord | null>;
  /** Poll interval in ms (fallback cadence when no signal fires). */
  pollMs: number;
  /** Grace delay in ms after a signal, to let the daemon persist before re-checking. */
  graceMs: number;
  /** Absolute deadline as epoch ms (Date.now()-style). */
  deadline: number;
  /**
   * Optional wake-signal registration. Called once with a callback; invoke the
   * callback whenever a relevant inbound envelope is observed. Omit for pure-poll.
   */
  onSignal?: (wake: () => void) => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep (tests). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForReply(deps: ReplyWaiterDeps): Promise<LocalMessageRecord | null> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let signaled = false;
  let wakeResolve: (() => void) | null = null;

  if (deps.onSignal) {
    deps.onSignal(() => {
      signaled = true;
      wakeResolve?.();
    });
  }

  while (now() < deps.deadline) {
    // Arm the wake BEFORE checking the store to avoid a lost wakeup: a signal that
    // fires while checkStore() is in flight still resolves this promise.
    signaled = false;
    const wake = new Promise<void>((resolve) => {
      wakeResolve = resolve;
    });

    const found = await deps.checkStore();
    if (found) return found;

    const remaining = deps.deadline - now();
    if (remaining <= 0) break;

    const waitMs = Math.min(deps.pollMs, remaining);
    await Promise.race([wake, sleep(waitMs)]);

    if (signaled) {
      const graceRemaining = deps.deadline - now();
      if (graceRemaining > 0) await sleep(Math.min(deps.graceMs, graceRemaining));
    }
  }

  return null;
}

/**
 * Build a predicate that matches an inbound envelope as the awaited reply:
 * same conversation AND sent by the peer we are waiting on. Envelope metadata is
 * plaintext (conversationId / senderAgentId), so this needs no decryption.
 */
export const buildReplyMatcher =
  (conversationId: string, fromAgentId: string, fromMemberId?: string) =>
  (envelope: { conversationId: string; senderAgentId: string; senderMemberId?: string }): boolean =>
    envelope.conversationId === conversationId &&
    envelope.senderAgentId === fromAgentId &&
    (!fromMemberId || envelope.senderMemberId === fromMemberId);
