export interface StatusVerdict { level: "grey" | "red" | "yellow" | "green"; unread: boolean; code: string; missing: string[]; missingWhy: Record<string, string> }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

// Presence is separate from null. Unknown extension keys remain additive.
const requiredKeys = [
  ["schema", "string"], ["generatedAt", "string"], ["service.state", "string"],
  ["broker.state", "string"], ["peers.list", "array"], ["inbox.unread", "number"],
  ["outbox.queue.failed", "number"], ["outbox.queue.dlq", "number"],
  ["wake.config.enabled", "boolean"], ["wake.faults.lastFault", "string"],
  ["wake.delivery.pendingUndelivered", "number"],
] as const;
const counterPaths = ["inbox.unread", "inbox.total", "outbox.queue.pending", "outbox.queue.inflight",
  "outbox.queue.delivered", "outbox.queue.failed", "outbox.queue.dlq", "wake.delivery.pendingUndelivered", "service.restartsLastHour",
  "outbox.attention.total", "outbox.attention.pending", "outbox.attention.dismissed"];
function lookup(input: unknown, path: string): { present: boolean; value?: unknown } {
  let value = input;
  for (const key of path.split(".")) {
    if (!record(value) || !Object.hasOwn(value, key)) return { present: false };
    value = value[key];
  }
  return { present: true, value };
}
function schemaFailure(input: unknown): string | null {
  const fields = requiredKeys.map(([path, kind]) => ({ ...lookup(input, path), kind }));
  if (fields.some(f => !f.present)) return "schema.missing-key";
  if (fields.some(f => f.value !== null && (Array.isArray(f.value) ? "array" : typeof f.value) !== f.kind)) return "schema.wrong-type";
  for (const path of counterPaths) {
    const { value } = lookup(input, path);
    if (typeof value === "number" && value < 0) return "schema.invalid-value";
  }
  // Native consumers decode these as integers; fractional/invalid values cannot
  // become a successful measurement in the JavaScript consumer either.
  for (const path of counterPaths) {
    const { present, value } = lookup(input, path);
    if (present && value !== null && !count(value)) return "schema.unparsable";
  }
  return null;
}

/** Shared policy, including 2.11 dead-letter acknowledgement and effective pause. */
export function statusVerdict(input: unknown, now = Date.now()): StatusVerdict {
  const s = record(input) ? input : {};
  const missing: string[] = [];
  const missingWhy: Record<string, string> = {};
  const note = (path: string, reason = "unmeasured") => { missing.push(path); missingWhy[path] = reason; };
  let unread = false;
  const out = (level: StatusVerdict["level"], code: string): StatusVerdict => ({ level, code, unread, missing: [...new Set(missing)].sort(), missingWhy });
  if (!record(input)) return out("grey", "status.unavailable");
  const invalid = schemaFailure(input);
  if (invalid) return out("grey", invalid);
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
    if (!count(value)) { note(name); return null; }
    return value;
  };
  const queue = s.outbox?.queue ?? {}, wake = s.wake ?? {};
  const failed = need("outbox.queue.failed", queue.failed);
  const dlq = need("outbox.queue.dlq", queue.dlq);
  if ((failed ?? 0) > 0) return out("red", "outbox.undelivered");
  if (typeof wake.faults?.lastFault === "string" && wake.faults.lastFault) return out("red", "wake.fault");
  const pendingWake = need("wake.delivery.pendingUndelivered", wake.delivery?.pendingUndelivered) ?? 0;
  const paused = wake.config?.enabled === false && wake.effective?.enabled === false && !wake.effective?.unknownReason;
  if (pendingWake > 0 && !paused) return out("red", "wake.pending");
  for (const [name, reason] of [
    ["outbox.faults", s.outbox?.faults?.unknownReason],
    ["wake.faults", wake.faults?.unknownReason],
    ["outbox.queue", queue.unknownReason], ["wake.delivery", wake.delivery?.unknownReason],
    ["wake.config", wake.config?.unknownReason], ["wake.effective", wake.effective?.unknownReason],
  ]) if (reason) note(name, "source-unreadable");
  switch (s.broker?.state) {
    case "unauthorized": return out("yellow", "broker.unauthorized");
    case "connected": break;
    case null: case undefined: case "": case "unknown": missing.push("broker.state"); break;
    default: return out("yellow", "broker.unreachable");
  }
  if (!Array.isArray(s.peers?.list)) note("peers.list", s.peers?.unknownReason ? "source-unreadable" : "unmeasured");
  else {
    if (!s.peers.list.length) return out("yellow", "peers.none");
    if (s.peers.list.some((p: any) => p?.paired === false)) return out("yellow", "peers.unpaired");
    const unknownPeers = s.peers.list.filter((p: any) => p?.paired !== true).map((p: any) => p?.agentId ?? "unknown");
    for (const peer of unknownPeers) note(`peers.list.${peer}.paired`);
  }
  if (!count(s.inbox?.unread)) note("inbox.unread", s.inbox?.unknownReason ? "source-unreadable" : "unmeasured");
  if (typeof wake.config?.enabled === "boolean" && typeof wake.effective?.enabled === "boolean"
    && wake.config.enabled !== wake.effective.enabled) return out("yellow", "wake.mode-mismatch");
  // Missing required fields never constitute measured health, even in malformed input.
  if (typeof wake.config?.enabled !== "boolean" && !wake.config?.unknownReason) note("wake.config.enabled");
  if (typeof wake.effective?.enabled !== "boolean" && !wake.effective?.unknownReason) note("wake.effective.enabled");
  const attention = s.outbox?.attention;
  const pendingDlq = attention?.schema === 'murmur.outbox-attention/1' && attention.unknownReason == null
    && count(attention.total) && attention.total === dlq && count(attention.pending) && count(attention.dismissed)
    && attention.pending + attention.dismissed === attention.total ? attention.pending : dlq;
  if ((pendingDlq ?? 0) > 0) return out('yellow', 'outbox.dead-letter');
  if (paused && pendingWake > 0) return out('yellow', 'wake.paused-pending');
  return missing.length ? out("grey", "unmeasured") : out("green", "ok");
}

/** A failed diagnostic stage prevents later stages from claiming measurements. */
export function doctorChainValid(input: unknown): boolean {
  if (!record(input) || !Array.isArray(input.stages)) return false;
  let failedAt: string | null = null;
  for (const stage of input.stages) {
    if (!record(stage) || typeof stage.id !== "string" || !["ok", "warn", "fail", "skip"].includes(stage.state)) return false;
    if (failedAt !== null) {
      if (stage.state !== "skip" || stage.reason !== `blocked-by:${failedAt}`) return false;
    } else if (stage.state === "fail") failedAt = stage.id;
  }
  return true;
}
