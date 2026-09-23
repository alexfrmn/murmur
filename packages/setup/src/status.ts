import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadConfig, readJson, safeError, type AgentConfig } from "./config.js";
import type { PlatformAdapter, ServiceContext, ServiceSnapshot } from "./types.js";

export type Measurement = { measuredAt: string | null; unknownReason: string | null };
const measured = (at: string): Measurement => ({ measuredAt: at, unknownReason: null });
const unknown = (reason: string): Measurement => ({ measuredAt: null, unknownReason: reason });
export const pairFingerprint = (config: AgentConfig, peerId: string) => createHash("sha256").update(JSON.stringify([
  config.agentId, config.keys.signing.publicKey, config.keys.encryption.publicKey, peerId,
  config.peers[peerId]?.signing.publicKey, config.peers[peerId]?.encryption.publicKey,
])).digest("hex");
export function validPairProof(proof: any, config: AgentConfig, peerId: string, now: number): boolean {
  const at = Date.parse(proof?.verifiedAt);
  return proof?.peerId === peerId && proof?.localAgentId === config.agentId
    && proof?.keyFingerprint === pairFingerprint(config, peerId)
    && Number.isFinite(at) && now - at >= -5000 && now - at <= 86400000;
}

export interface StatusOptions { context: ServiceContext; adapter: PlatformAdapter; now?: () => number }

export async function readStatus({ context: c, adapter, now = Date.now }: StatusOptions) {
  const started = now();
  const at = new Date(started).toISOString();
  let config: AgentConfig | null = null;
  let configError: string | null = null;
  try { config = await loadConfig(c); } catch (e) { configError = safeError(e); }
  let service: ServiceSnapshot;
  try { service = await adapter.status(c); } catch { service = { state: "unknown", manager: adapter.manager,
    since: null, pid: null, lastExitCode: null, observedStorePath: null, restartCount: null,
    restartWindowMs: null, detail: "service.measurement-failed" }; }
  const restartsLastHour = service.restartWindowMs === 3600000 && Number.isSafeInteger(service.restartCount)
    && service.restartCount !== null && service.restartCount >= 0 ? service.restartCount : null;
  if (restartsLastHour !== null && restartsLastHour >= 5) service = { ...service, state: "failed", detail: "service.restart-loop" };

  let observation: any = null;
  let runtimeMeasurement = unknown("runtime.observation-unavailable");
  try {
    const raw = await readJson(path.join(c.dataDir, "daemon-observation.json"));
    const timestamp = Date.parse(raw.measuredAt);
    const storePath = await realpath(c.storePath);
    if (raw.schema === "murmur.runtime/1" && service.state === "running" && raw.pid === service.pid
      && raw.agentId === config?.agentId && raw.storePath === storePath && service.observedStorePath === storePath
      && Number.isFinite(timestamp) && started - timestamp >= -5000 && started - timestamp <= 15000
      && ["connected", "disconnected", "unauthorized", "unknown"].includes(raw.broker?.state)
      && typeof raw.wake?.enabled === "boolean" && ["hook", "monitor", "none"].includes(raw.wake?.mode)) {
      observation = raw;
      runtimeMeasurement = measured(raw.measuredAt);
    } else runtimeMeasurement = unknown("runtime.observation-unverified-or-stale");
  } catch { /* Absent legacy telemetry is unknown, never reconstructed from config. */ }

  const inbox = { unread: null as number | null, total: null as number | null, lastAt: null as string | null,
    unknownReason: null as string | null, measurements: { store: unknown("store.unavailable"), cursor: unknown("inbox.cursor-unavailable") } };
  const outbox = { pending: null as number | null, inflight: null as number | null, delivered: null as number | null,
    failed: null as number | null, dlq: null as number | null, oldestPendingAt: null as string | null,
    lastError: null as string | null, lastErrorAt: null as string | null, unknownReason: null as string | null,
    measurements: { store: unknown("store.unavailable") } };
  const wake = { enabled: observation?.wake?.enabled ?? null, mode: observation?.wake?.mode ?? null,
    responder: observation?.wake?.responder ?? null, storedOnly: null as number | null,
    pendingUndelivered: null as number | null, lastDeliveredAt: null as string | null,
    lastFault: null as string | null, lastFaultAt: null as string | null, unknownReason: null as string | null,
    measurements: { store: unknown("store.unavailable"), runtime: runtimeMeasurement } };
  const peers: { list: Array<{ agentId: string; paired: boolean | null; lastInboundAt: string | null; lastOutboundAt: string | null }> | null;
    unknownReason: string | null; measurements: Record<string, Measurement> } = {
    list: config ? Object.keys(config.peers).map((agentId) => ({ agentId, paired: null, lastInboundAt: null, lastOutboundAt: null })) : null,
    unknownReason: configError, measurements: { config: config ? measured(at) : unknown(configError ?? "config.unavailable"), store: unknown("store.unavailable"), proof: unknown("peers.proof-unavailable") },
  };
  let deliveries: Array<Record<string, unknown>> | null = null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(c.storePath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=1000; BEGIN");
    const summary = db.prepare("SELECT COUNT(*) AS total, MAX(created_at) AS lastAt, COALESCE(MAX(rowid),0) AS tip FROM local_messages WHERE direction='inbound'").get() as any;
    inbox.total = Number(summary.total); inbox.lastAt = summary.lastAt;
    inbox.measurements.store = measured(at);
    try {
      const cursor = await readJson(path.join(c.dataDir, "read-state.json"));
      if (cursor.schema !== "murmur.read/1" || cursor.agentId !== config?.agentId || !Number.isSafeInteger(cursor.rowid)
        || cursor.rowid < 0 || cursor.rowid > Number(summary.tip)) throw new Error("inbox.cursor-invalid");
      inbox.unread = Number((db.prepare("SELECT COUNT(*) AS n FROM local_messages WHERE direction='inbound' AND rowid>?").get(cursor.rowid) as any).n);
      inbox.measurements.cursor = measured(at);
    } catch { /* A missing cursor is not an empty inbox. */ }
    const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status").all().map((r: any) => [r.status, Number(r.n)]));
    outbox.pending = counts.pending ?? 0; outbox.inflight = counts.sent ?? 0; outbox.delivered = counts.acked ?? 0;
    outbox.failed = counts.failed ?? 0; outbox.dlq = counts.dlq ?? 0;
    outbox.oldestPendingAt = (db.prepare("SELECT MIN(created_at) AS at FROM outbox WHERE status IN ('pending','sent','failed')").get() as any).at;
    const error = db.prepare("SELECT last_error,updated_at FROM outbox WHERE last_error IS NOT NULL AND last_error!='' ORDER BY updated_at DESC LIMIT 1").get() as any;
    outbox.lastError = error ? safeError(error.last_error) : null; outbox.lastErrorAt = error?.updated_at ?? null;
    outbox.measurements.store = measured(at);
    try {
      const rows = Object.fromEntries(db.prepare("SELECT wake_status,COUNT(*) AS n FROM local_messages WHERE direction='inbound' GROUP BY wake_status").all().map((r: any) => [r.wake_status, Number(r.n)]));
      wake.storedOnly = rows["stored-only"] ?? 0;
      wake.pendingUndelivered = (rows.pending ?? 0) + (rows.inflight ?? 0) + (rows.failed ?? 0);
      wake.lastDeliveredAt = (db.prepare("SELECT MAX(wake_updated_at) AS at FROM local_messages WHERE direction='inbound' AND wake_status='handled'").get() as any).at;
      const fault = db.prepare("SELECT wake_error,wake_updated_at FROM local_messages WHERE direction='inbound' AND wake_status IN ('failed','dlq') AND wake_error IS NOT NULL ORDER BY wake_updated_at DESC LIMIT 1").get() as any;
      wake.lastFault = fault ? safeError(fault.wake_error) : null; wake.lastFaultAt = fault?.wake_updated_at ?? null;
      wake.measurements.store = measured(at);
    } catch { wake.measurements.store = unknown("wake.store-schema-unavailable"); }
    for (const peer of peers.list ?? []) {
      peer.lastInboundAt = (db.prepare("SELECT MAX(created_at) AS at FROM local_messages WHERE direction='inbound' AND sender=?").get(peer.agentId) as any).at;
      peer.lastOutboundAt = (db.prepare("SELECT MAX(created_at) AS at FROM outbox WHERE json_extract(envelope_json,'$.recipients[0]')=?").get(peer.agentId) as any).at;
    }
    peers.measurements.store = measured(at);
    const outbound = db.prepare("SELECT msg_id AS msgId,json_extract(envelope_json,'$.recipients[0]') AS peer,'outbound' AS direction,CASE status WHEN 'acked' THEN 'delivered' WHEN 'sent' THEN 'inflight' ELSE status END AS state,updated_at AS at,attempts,last_error AS error FROM outbox ORDER BY updated_at DESC LIMIT 20").all();
    const inbound = db.prepare("SELECT msg_id AS msgId,sender AS peer,'inbound' AS direction,'delivered' AS state,created_at AS at,0 AS attempts,NULL AS error FROM local_messages WHERE direction='inbound' ORDER BY created_at DESC LIMIT 20").all();
    deliveries = [...outbound, ...inbound].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20).map((r) => ({ ...r, error: r.error ? safeError(r.error) : null }));
    db.exec("COMMIT");
  } catch {
    // Keep independently completed measurements; each source names its uncertainty.
  } finally { db?.close(); }
  if (config) {
    try {
      const proofs = await readJson(path.join(c.dataDir, "pair-proofs.json"));
      for (const peer of peers.list ?? []) peer.paired = validPairProof(proofs[peer.agentId], config, peer.agentId, started) ? true : null;
      peers.measurements.proof = measured(at);
    } catch { /* No roundtrip evidence: every pairing stays unknown. */ }
  }
  const reason = (sources: Record<string, Measurement>) => Object.entries(sources).filter(([, v]) => v.unknownReason).map(([name, v]) => `${name}:${v.unknownReason}`).join("; ") || null;
  inbox.unknownReason = reason(inbox.measurements); outbox.unknownReason = reason(outbox.measurements);
  wake.unknownReason = reason(wake.measurements); peers.unknownReason = reason(peers.measurements);
  return {
    schema: "murmur.status/1" as const, generatedAt: at, agentId: config?.agentId ?? null, serviceName: c.serviceName,
    service: { ...service, lastFailureAt: null, restartsLastHour, restartFailureThreshold: 5,
      unknownReason: service.state === "unknown" ? service.detail ?? "service.unavailable" : null,
      measurements: { manager: service.state === "unknown" ? unknown(service.detail ?? "service.unavailable") : measured(at), history: unknown("service.history-unavailable") } },
    broker: { url: config?.natsUrl ?? null, state: observation?.broker?.state ?? "unknown",
      connectedAt: observation?.broker?.connectedAt ?? null, lastError: observation?.broker?.lastError ?? null,
      lastErrorAt: observation?.broker?.lastErrorAt ?? null, unknownReason: runtimeMeasurement.unknownReason,
      measurements: { runtime: runtimeMeasurement } },
    peers, inbox, deliveries,
    outbox: {
      queue: { pending: outbox.pending, inflight: outbox.inflight, delivered: outbox.delivered,
        failed: outbox.failed, dlq: outbox.dlq, oldestPendingAt: outbox.oldestPendingAt,
        unknownReason: outbox.measurements.store.unknownReason },
      faults: { lastError: outbox.lastError, lastErrorAt: outbox.lastErrorAt,
        unknownReason: outbox.measurements.store.unknownReason, source: "durable-outbox" },
    },
    wake: {
      config: { enabled: config ? config.wake?.enabled !== false : null,
        mode: config ? configuredWakeMode(config) : null,
        responder: config ? configuredWakeMode(config) === "monitor" ? "codex" : config.onReceive ? null : "none" : null,
        unknownReason: configError },
      effective: { enabled: wake.enabled,
        needsRestart: config && typeof wake.enabled === "boolean" ? (config.wake?.enabled !== false) !== wake.enabled : null,
        observedAt: runtimeMeasurement.measuredAt, unknownReason: runtimeMeasurement.unknownReason },
      delivery: { pendingUndelivered: wake.pendingUndelivered, storedOnly: wake.storedOnly,
        lastDeliveredAt: wake.lastDeliveredAt, unknownReason: wake.measurements.store.unknownReason },
      faults: {
        lastFault: observation?.wake?.lastFault && (!wake.lastFaultAt || observation.wake.lastFaultAt > wake.lastFaultAt)
          ? safeError(observation.wake.lastFault) : wake.lastFault,
        lastFaultAt: observation?.wake?.lastFault && (!wake.lastFaultAt || observation.wake.lastFaultAt > wake.lastFaultAt)
          ? observation.wake.lastFaultAt : wake.lastFaultAt,
        unknownReason: reason({ store: wake.measurements.store, runtime: runtimeMeasurement }),
        measurements: { store: wake.measurements.store, runtime: runtimeMeasurement },
      },
    },
  };
}

export function configuredWakeMode(config: AgentConfig): "hook" | "monitor" | "none" {
  return config.wake?.mode === "codex_app_server" || Object.values(config.wake?.peers ?? {}).some(p => p.mode === "codex_app_server")
    ? "monitor" : config.onReceive ? "hook" : "none";
}
