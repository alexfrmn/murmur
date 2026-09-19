export interface StatusVerdict { level: "grey" | "red" | "yellow" | "green"; unread: boolean; code: string; missing: string[] }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

/** Frozen 78b40c4 policy. The caller supplies the clock; fixtures own expectations. */
export function statusVerdict(input: unknown, now = Date.now()): StatusVerdict {
  const s = record(input) ? input : {};
  const missing: string[] = [];
  let unread = false;
  const out = (level: StatusVerdict["level"], code: string): StatusVerdict => ({ level, code, unread, missing: [...new Set(missing)].sort() });
  if (!record(input)) return out("grey", "status.unavailable");
  if (typeof s.schema !== "string" || !/^murmur\.status\/1(?:\.\d+)?$/.test(s.schema)) return out("grey", "schema.unknown");
  unread = count(s.inbox?.unread) && s.inbox.unread > 0;
  const stamp = typeof s.generatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s.generatedAt) ? Date.parse(s.generatedAt) : NaN;
  if (!Number.isFinite(stamp) || !Number.isFinite(now)) return out("grey", "snapshot.unparsable");
  if (now - stamp > 120000) return out("grey", "snapshot.stale");
  if (stamp - now > 5000) return out("grey", "snapshot.future");
  if (s.service?.state === "stopped") return out("grey", "service.stopped");
  if (!["running", "failed"].includes(s.service?.state)) return out("grey", "service.unknown");
  if (s.service.state === "failed") return out("red", "service.failed");
  const need = (name: string, value: unknown) => {
    if (!count(value)) { missing.push(name); return null; }
    return value;
  };
  const queue = s.outbox?.queue ?? {}, wake = s.wake ?? {};
  const failed = need("outbox.queue.failed", queue.failed);
  const dlq = need("outbox.queue.dlq", queue.dlq);
  if ((failed ?? 0) > 0 || (dlq ?? 0) > 0) return out("red", "outbox.undelivered");
  if (typeof wake.faults?.lastFault === "string" && wake.faults.lastFault) return out("red", "wake.fault");
  if ((need("wake.delivery.pendingUndelivered", wake.delivery?.pendingUndelivered) ?? 0) > 0) return out("red", "wake.pending");
  for (const [name, reason] of [
    ["журнал отказов отправки", s.outbox?.faults?.unknownReason],
    ["журнал отказов пробуждения", wake.faults?.unknownReason],
    ["очередь", queue.unknownReason], ["доставка wake", wake.delivery?.unknownReason],
    ["настройки wake", wake.config?.unknownReason], ["действующее состояние wake", wake.effective?.unknownReason],
  ]) if (reason) missing.push(`${name} (${reason})`);
  switch (s.broker?.state) {
    case "unauthorized": return out("yellow", "broker.unauthorized");
    case "connected": break;
    case undefined: case "": case "unknown": missing.push("broker.state"); break;
    default: return out("yellow", "broker.unreachable");
  }
  const label = (name: string, reason: unknown) => name + (reason ? ` (${reason})` : "");
  if (!Array.isArray(s.peers?.list)) missing.push(label("peers.list", s.peers?.unknownReason));
  else {
    if (!s.peers.list.length) return out("yellow", "peers.none");
    if (s.peers.list.some((p: any) => p?.paired === false)) return out("yellow", "peers.unpaired");
    const unknownPeers = s.peers.list.filter((p: any) => p?.paired !== true).map((p: any) => p?.agentId ?? "unknown");
    if (unknownPeers.length) missing.push(`парность неизвестна: ${unknownPeers.join(", ")}`);
  }
  if (!count(s.inbox?.unread)) missing.push(label("inbox.unread", s.inbox?.unknownReason));
  if (typeof wake.config?.enabled === "boolean" && typeof wake.effective?.enabled === "boolean"
    && wake.config.enabled !== wake.effective.enabled) return out("yellow", "wake.mode-mismatch");
  // Missing required fields never constitute measured health, even in malformed input.
  if (!record(wake.faults) || !Object.hasOwn(wake.faults, "lastFault")) missing.push("wake.faults.lastFault");
  if (typeof wake.config?.enabled !== "boolean" && !wake.config?.unknownReason) missing.push("wake.config.enabled");
  if (typeof wake.effective?.enabled !== "boolean" && !wake.effective?.unknownReason) missing.push("wake.effective.enabled");
  return missing.length ? out("grey", "unmeasured") : out("green", "ok");
}
