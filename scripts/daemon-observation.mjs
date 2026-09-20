import path from "node:path";
import { realpath } from "node:fs/promises";
import { writePrivateJson } from "./secure-state.mjs";

/** Non-secret, PID/store-bound liveness evidence for the read-only setup CLI. */
export function createDaemonObservation({ dataDir, storePath, agentId, wake, log = () => {} }) {
  const startedAt = new Date().toISOString();
  const snapshot = { schema: "murmur.runtime/1", agentId, pid: process.pid, startedAt,
    storePath: null, measuredAt: null, wake: { ...wake, lastFault: null, lastFaultAt: null },
    broker: { state: "unknown", connectedAt: null, lastError: null, lastErrorAt: null } };
  let writing = false;
  let timer;
  const write = async () => {
    if (writing) return;
    writing = true;
    try {
      snapshot.storePath = await realpath(storePath);
      snapshot.measuredAt = new Date().toISOString();
      await writePrivateJson(path.join(dataDir, "daemon-observation.json"), snapshot);
    } catch { log("warn", "Daemon observation write failed", { reason: "runtime.observation-write-failed" }); }
    finally { writing = false; }
  };
  return {
    async start() { await write(); timer = setInterval(() => { void write(); }, 5000); timer.unref(); },
    async connected() { snapshot.broker.state = "connected"; snapshot.broker.connectedAt = new Date().toISOString(); await write(); },
    onStatus(event) {
      if (event.type === "disconnect") {
        snapshot.broker.state = "disconnected";
        snapshot.broker.lastError = "broker.disconnected";
        snapshot.broker.lastErrorAt = new Date().toISOString();
      } else if (event.type === "reconnect") {
        snapshot.broker.state = "connected";
        snapshot.broker.connectedAt = new Date().toISOString();
      }
      void write();
    },
    observeLog(level, message, data) {
      // Preserve a monitor crash even when SQLite could not record the failed wake.
      // Never persist hook commands, stdout, message text or arbitrary error strings.
      if ((level === "error" || level === "fatal") && message.startsWith("WakeMonitor")) {
        snapshot.wake.lastFault = data?.error === "database is locked" ? "wake.database-locked" : "wake.runtime-fault";
        snapshot.wake.lastFaultAt = new Date().toISOString();
        void write();
      }
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
