/**
 * Server link tracker (#276).
 *
 * nats.js reports the life of a connection through `nc.status()`. Before this module the
 * daemon forwarded only `disconnect`, `reconnect` and `update`; every failed reconnect
 * attempt (`reconnecting`), every async server error (`error`) and a stale connection
 * (`staleConnection`) were dropped on the floor. A daemon whose broker went away logged one
 * `disconnect` line and then nothing, for days, while its supervisor considered it healthy.
 *
 * The tracker turns the raw status stream into (a) an event for the daemon's observation
 * file and (b) a log line with stable, non-secret fields, rate-limited so a reconnect loop
 * writes one line per interval instead of one per attempt. It also remembers when the
 * link was lost so `disconnected since` can be shown and acted upon.
 */

export type BrokerLinkState = "connected" | "disconnected";

export interface BrokerLinkSnapshot {
  state: BrokerLinkState;
  /** RFC3339 instant of the loss; null while connected. */
  disconnectedAt: string | null;
  /** Failed reconnect attempts since the link was lost. */
  reconnectAttempts: number;
  /** Last stable failure reason, e.g. `broker.unauthorized`; never raw error text. */
  lastReason: string | null;
  lastReasonAt: string | null;
}

export interface BrokerLinkEvent {
  type: string;
  data?: unknown;
  reconnects: number;
}

export interface BrokerLinkLog {
  level: "info" | "warn" | "error";
  message: string;
  data: Record<string, unknown>;
}

export interface BrokerLinkOutcome {
  event?: BrokerLinkEvent;
  log?: BrokerLinkLog;
}

export interface BrokerLinkTrackerOptions {
  /** Minimum spacing between two log lines of the same kind. Default 60 s. */
  logIntervalMs?: number;
  now?: () => number;
}

/** Stable diagnostics only: never copy an endpoint, token, or arbitrary error text. */
export function brokerConnectionReason(error: unknown): string {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case "AUTHORIZATION_VIOLATION": case "AUTHENTICATION_EXPIRED": return "broker.unauthorized";
    case "PERMISSIONS_VIOLATION": return "broker.permission-denied";
    case "ECONNREFUSED": case "CONNECTION_REFUSED": return "broker.connection-refused";
    case "ENOTFOUND": case "EAI_AGAIN": return "broker.name-unresolved";
    case "ETIMEDOUT": case "TIMEOUT": case "CONNECTION_TIMEOUT": return "broker.timeout";
    default: return "broker.connection-failed";
  }
}

export interface BrokerLinkTracker {
  snapshot(): BrokerLinkSnapshot;
  /** Milliseconds since the link was lost; 0 while connected. */
  disconnectedForMs(at?: number): number;
  /** Feed one `nc.status()` entry; returns what to emit and what to log. */
  handle(status: { type: string; data?: unknown }, reconnects: number): BrokerLinkOutcome;
  /** The connection will never come back on its own (auth abort, attempts exhausted, close). */
  closed(error: unknown, reconnects: number): BrokerLinkOutcome;
}

export function createBrokerLinkTracker(options: BrokerLinkTrackerOptions = {}): BrokerLinkTracker {
  const logIntervalMs = options.logIntervalMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const snapshot: BrokerLinkSnapshot = {
    state: "connected", disconnectedAt: null, reconnectAttempts: 0, lastReason: null, lastReasonAt: null,
  };
  const lastLogAt = new Map<string, number>();
  const iso = (ms: number): string => new Date(ms).toISOString();

  const rateLimited = (key: string, at: number): boolean => {
    const previous = lastLogAt.get(key);
    if (previous !== undefined && at - previous < logIntervalMs) return true;
    lastLogAt.set(key, at);
    return false;
  };
  const disconnectedForMs = (at: number): number =>
    snapshot.disconnectedAt === null ? 0 : Math.max(0, at - Date.parse(snapshot.disconnectedAt));
  const lost = (at: number): void => {
    if (snapshot.state === "disconnected") return;
    snapshot.state = "disconnected";
    snapshot.disconnectedAt = iso(at);
    snapshot.reconnectAttempts = 0;
    lastLogAt.clear();
  };
  const restored = (): void => {
    snapshot.state = "connected";
    snapshot.disconnectedAt = null;
    snapshot.reconnectAttempts = 0;
    lastLogAt.clear();
  };
  const remember = (reason: string, at: number): void => {
    snapshot.lastReason = reason;
    snapshot.lastReasonAt = iso(at);
  };

  return {
    snapshot: () => ({ ...snapshot }),
    disconnectedForMs: (at = now()) => disconnectedForMs(at),

    handle(status, reconnects) {
      const at = now();
      switch (status.type) {
        case "disconnect": {
          lost(at);
          return {
            event: { type: "disconnect", data: status.data, reconnects },
            log: { level: "warn", message: "Server link lost; reconnecting",
              data: { disconnectedAt: snapshot.disconnectedAt, reconnects } },
          };
        }
        case "reconnecting": {
          // A reconnect loop can start without a preceding `disconnect` (initial connect
          // with waitOnFirstConnect); treat the first attempt as the moment of loss.
          lost(at);
          snapshot.reconnectAttempts += 1;
          const data = { attempts: snapshot.reconnectAttempts, disconnectedAt: snapshot.disconnectedAt,
            disconnectedForMs: disconnectedForMs(at) };
          const event = { type: "reconnecting", data, reconnects };
          if (rateLimited("reconnecting", at)) return { event };
          return { event, log: { level: "warn", message: "Server link still lost; reconnect attempts continue", data } };
        }
        case "reconnect": {
          const wasDisconnectedForMs = disconnectedForMs(at);
          const attempts = snapshot.reconnectAttempts;
          restored();
          return {
            event: { type: "reconnect", data: status.data, reconnects },
            log: { level: "info", message: "Server link restored", data: { reconnects, attempts, wasDisconnectedForMs } },
          };
        }
        case "update":
          return {
            event: { type: "update", data: status.data, reconnects },
            log: { level: "info", message: "Server cluster update", data: { reconnects } },
          };
        case "error": {
          const reason = brokerConnectionReason(status.data);
          remember(reason, at);
          const event = { type: "error", data: { reason }, reconnects };
          if (rateLimited(`error:${reason}`, at)) return { event };
          return { event, log: { level: "warn", message: "Server reported an error",
            data: { reason, disconnectedAt: snapshot.disconnectedAt } } };
        }
        case "staleConnection": {
          const reason = "broker.stale-connection";
          remember(reason, at);
          const event = { type: "staleConnection", data: { reason }, reconnects };
          if (rateLimited("staleConnection", at)) return { event };
          return { event, log: { level: "warn", message: "Server stopped answering pings; the client will reconnect", data: { reason } } };
        }
        case "ldm":
          return {
            event: { type: "ldm", reconnects },
            log: { level: "info", message: "Server entering lame duck mode; a reconnect will follow", data: {} },
          };
        default:
          // pingTimer, client initiated reconnect: routine, not worth a line.
          return {};
      }
    },

    closed(error, reconnects) {
      const at = now();
      lost(at);
      const reason = error ? brokerConnectionReason(error) : "broker.closed";
      remember(reason, at);
      const data = { reason, disconnectedAt: snapshot.disconnectedAt, attempts: snapshot.reconnectAttempts };
      return {
        event: { type: "closed", data, reconnects },
        log: { level: "error", message: "Server connection closed for good; it will not reconnect on its own", data },
      };
    },
  };
}
