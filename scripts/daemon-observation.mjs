import path from "node:path";
import { realpath } from "node:fs/promises";
import { writePrivateJson } from "./secure-state.mjs";

/** Non-secret, PID/store-bound liveness evidence for the read-only setup CLI. */
export function createDaemonObservation({ dataDir, storePath, agentId, wake, contacts = () => null, log = () => {} }) {
  const startedAt = new Date().toISOString();
  const snapshot = { schema: "murmur.runtime/1", agentId, pid: process.pid, startedAt,
    storePath: null, measuredAt: null, wake: { ...wake, lastFault: null, lastFaultAt: null },
    broker: { state: "disconnected", connectedAt: null, lastError: "broker.connecting", lastErrorAt: startedAt } };
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
    async connected() { snapshot.broker.state = "connected"; snapshot.broker.connectedAt = new Date().toISOString(); await write(); },
    onStatus(event) {
      if (event.type === "connect_error") {
        const reasons = ["broker.unauthorized", "broker.connection-refused", "broker.name-unresolved", "broker.timeout", "broker.connection-failed"];
        const reason = reasons.includes(event.data?.reason) ? event.data.reason : "broker.connection-failed";
        snapshot.broker.state = reason === "broker.unauthorized" ? "unauthorized" : "disconnected";
        snapshot.broker.lastError = reason;
        snapshot.broker.lastErrorAt = new Date().toISOString();
        log("warn", "Server connection failed; will retry", { reason });
      } else if (event.type === "disconnect") {
        snapshot.broker.state = "disconnected";
        snapshot.broker.lastError = "broker.disconnected";
        snapshot.broker.lastErrorAt = new Date().toISOString();
      } else if (event.type === "reconnect") {
        snapshot.broker.state = "connected";
        snapshot.broker.connectedAt = new Date().toISOString();
      }
      return write();
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
