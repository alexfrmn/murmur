import path from "node:path";
import { realpath } from "node:fs/promises";
import { writePrivateJson } from "./secure-state.mjs";

/** Non-secret, PID/store-bound liveness evidence for the read-only setup CLI. */
export function createDaemonObservation({ dataDir, storePath, agentId, wake, contacts = () => null, log = () => {} }) {
  const startedAt = new Date().toISOString();
  const snapshot = { schema: "murmur.runtime/1", agentId, pid: process.pid, startedAt,
    storePath: null, measuredAt: null, wake: { ...wake, lastFault: null, lastFaultAt: null },
    broker: { state: "disconnected", connectedAt: null, disconnectedAt: startedAt, reconnectAttempts: 0,
      lastError: "broker.connecting", lastErrorAt: startedAt } };
  const knownReasons = ["broker.unauthorized", "broker.permission-denied", "broker.connection-refused", "broker.name-unresolved",
    "broker.timeout", "broker.connection-failed", "broker.stale-connection", "broker.closed"];
  const safeReason = (value) => knownReasons.includes(value) ? value : "broker.connection-failed";
  let writes = Promise.resolve();
  let timer;
  const write = () => writes = writes.then(async () => {
    try {
      snapshot.storePath = await realpath(storePath);
      snapshot.measuredAt = new Date().toISOString();
      snapshot.contacts = contacts();
      await writePrivateJson(path.join(dataDir, "daemon-observation.json"), snapshot);
    } catch { log("warn", "Daemon observation write failed", { reason: "runtime.observation-write-failed" }); }
  });
  return {
    async start() {
      log("info", "Connecting to server", { reason: "broker.connecting" });
      await write(); timer = setInterval(() => { void write(); }, 5000); timer.unref();
    },
    async connected() {
      const broker = snapshot.broker;
      broker.state = "connected"; broker.connectedAt = new Date().toISOString();
      broker.disconnectedAt = null; broker.reconnectAttempts = 0;
      await write();
    },
    onStatus(event) {
      const broker = snapshot.broker;
      const at = new Date().toISOString();
      if (event.type === "connect_error") {
        const reason = safeReason(event.data?.reason);
        broker.state = reason === "broker.unauthorized" ? "unauthorized" : "disconnected";
        broker.lastError = reason;
        broker.lastErrorAt = at;
        if (broker.disconnectedAt === null) broker.disconnectedAt = at;
        log("warn", "Server connection failed; will retry", { reason });
      } else if (event.type === "disconnect") {
        broker.state = "disconnected";
        broker.lastError = "broker.disconnected";
        broker.lastErrorAt = at;
        if (broker.disconnectedAt === null) broker.disconnectedAt = at;
        broker.reconnectAttempts = 0;
      } else if (event.type === "reconnecting") {
        // #276 — every failed reconnect attempt is counted here; the broker logs them rate-limited.
        if (broker.state === "connected") broker.state = "disconnected";
        if (broker.disconnectedAt === null) {
          broker.disconnectedAt = typeof event.data?.disconnectedAt === "string" ? event.data.disconnectedAt : at;
        }
        broker.reconnectAttempts = Number.isSafeInteger(event.data?.attempts) ? event.data.attempts : broker.reconnectAttempts + 1;
        broker.lastError = "broker.reconnecting";
        broker.lastErrorAt = at;
      } else if (event.type === "error" || event.type === "staleConnection") {
        const reason = safeReason(event.data?.reason);
        broker.lastError = reason;
        broker.lastErrorAt = at;
        if (reason === "broker.unauthorized" && broker.state !== "connected") broker.state = "unauthorized";
      } else if (event.type === "closed") {
        // The client gave up (auth abort, attempts exhausted): nothing reconnects this process.
        const reason = safeReason(event.data?.reason);
        broker.state = "closed";
        broker.lastError = reason;
        broker.lastErrorAt = at;
        if (broker.disconnectedAt === null) broker.disconnectedAt = at;
        log("error", "Server connection closed for good; it will not reconnect on its own", { reason });
      } else if (event.type === "reconnect") {
        broker.state = "connected";
        broker.connectedAt = at;
        broker.disconnectedAt = null;
        broker.reconnectAttempts = 0;
      }
      return write();
    },
    /** Read-only copy of the broker part of the snapshot. */
    broker() { return { ...snapshot.broker }; },
    /** Milliseconds since the server link was lost; 0 while connected. */
    disconnectedForMs(now = Date.now()) {
      const broker = snapshot.broker;
      if (broker.state === "connected" || !broker.disconnectedAt) return 0;
      return Math.max(0, now - Date.parse(broker.disconnectedAt));
    },
    observeLog(level, message, data) {
      // This verdict was already committed to its message row. Let status follow
      // that row (including an explicit CLI dismissal), not a sticky runtime fault.
      if (message === 'WakeMonitor wake dead-lettered' && data?.error === 'accepted-turn-unobservable') return;
      // Preserve a monitor crash even when SQLite could not record the failed wake.
      // Never persist hook commands, stdout, message text or arbitrary error strings.
      if ((level === "error" || level === "fatal") && message.startsWith("WakeMonitor")) {
        snapshot.wake.lastFault = data?.error === "database is locked" ? "wake.database-locked" : "wake.runtime-fault";
        snapshot.wake.lastFaultAt = new Date().toISOString();
        return write();
      }
    },
    async stop() { if (timer) clearInterval(timer); await writes; },
  };
}
