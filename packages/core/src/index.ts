import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Agent discovery (presence frames + candidate registry)
export * from "./discovery.js";

// Scoped channels — session-ownership lease (session affinity, fencing token, presence-deferring wake gate)
export * from "./lease.js";

// Phase N — typed channel roster (channelId distinct from legacy conversationId)
export * from "./channel.js";

export type DeliveryMode = "at-least-once";

export interface EnvelopeV1 {
  schemaVersion: "1.0";
  msgId: string;
  conversationId: string;
  senderAgentId: string;
  recipients: string[];
  createdAt: string;
  ttlSeconds?: number;
  traceId?: string;
  sequence?: number;
  parentMsgId?: string;
  /** Optional bearer auth token (`MURMUR-AUTH:...`) authorizing the sender. When present
   *  it is part of the signed payload (so it can't be stripped/swapped) and can be
   *  verified with @murmurv2/federation `verifyAuthToken`. Ingress enforcement (an
   *  `authorizeInbound` helper gated by `MURMUR_ENFORCE_AUTH`) is forthcoming in
   *  auth/authz #47 PR-D. Absent on un-authenticated envelopes — those sign
   *  byte-identically to before this field existed. */
  authToken?: string;
  payloadCiphertext: string;
  payloadNonce: string;
  signature: string;
}

export interface AckV1 {
  msgId: string;
  consumerId: string;
  status: "ack" | "nack";
  reason?: string;
  at: string;
}

export interface SignedAckV1 {
  ackVersion: "1.0";
  msgId: string;
  messageDigest: string;
  conversationId: string;
  senderAgentId: string;
  recipientAgentId: string;
  status: "ack" | "nack";
  reason?: string;
  at: string;
  nonce: string;
  signature: string;
}

export type UnsignedAckV1 = Omit<SignedAckV1, "signature">;

export const envelopeDigest = (envelope: EnvelopeV1): string =>
  `sha256:${createHash("sha256").update(stableEnvelopePayload(envelope)).digest("hex")}`;

export const stableAckPayload = (ack: UnsignedAckV1 | SignedAckV1): string =>
  JSON.stringify({
    ackVersion: ack.ackVersion,
    msgId: ack.msgId,
    messageDigest: ack.messageDigest,
    conversationId: ack.conversationId,
    senderAgentId: ack.senderAgentId,
    recipientAgentId: ack.recipientAgentId,
    status: ack.status,
    ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
    at: ack.at,
    nonce: ack.nonce,
  });

export const isSignedAckV1 = (value: unknown): value is SignedAckV1 => {
  if (!value || typeof value !== "object") return false;
  const ack = value as Record<string, unknown>;
  return (
    ack.ackVersion === "1.0" &&
    typeof ack.msgId === "string" && ack.msgId.length > 0 &&
    typeof ack.messageDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(ack.messageDigest) &&
    typeof ack.conversationId === "string" && ack.conversationId.length > 0 &&
    typeof ack.senderAgentId === "string" && ack.senderAgentId.length > 0 &&
    typeof ack.recipientAgentId === "string" && ack.recipientAgentId.length > 0 &&
    (ack.status === "ack" || ack.status === "nack") &&
    (ack.reason === undefined || typeof ack.reason === "string") &&
    typeof ack.at === "string" && !Number.isNaN(Date.parse(ack.at)) &&
    typeof ack.nonce === "string" && ack.nonce.length > 0 &&
    typeof ack.signature === "string" && ack.signature.length > 0
  );
};

/**
 * Canonical signing payload for an EnvelopeV1 — the SINGLE SOURCE OF TRUTH every
 * signer and verifier MUST use, so signatures interoperate across the whole mesh
 * (mcp-server, daemon, bridges, runner, demos). The `signature` field is excluded
 * by design (it signs everything else) and field order is fixed. Changing the shape
 * or order is a wire-breaking change: update every signer together and bump the
 * protocol. Previously copy-pasted in 5+ places; keep it here only.
 */
export const stableEnvelopePayload = (envelope: EnvelopeV1): string =>
  JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    msgId: envelope.msgId,
    conversationId: envelope.conversationId,
    senderAgentId: envelope.senderAgentId,
    recipients: [...envelope.recipients],
    createdAt: envelope.createdAt,
    payloadCiphertext: envelope.payloadCiphertext,
    payloadNonce: envelope.payloadNonce,
    // authToken is appended ONLY when present, in a fixed final position: envelopes
    // without it sign byte-identically to before this field existed (back-compat),
    // and when present it is covered by the signature so it can't be stripped/swapped.
    ...(envelope.authToken !== undefined ? { authToken: envelope.authToken } : {}),
  });

export interface DedupeStore {
  seen(msgId: string, consumerId: string): Promise<boolean>;
  markSeen(msgId: string, consumerId: string): Promise<void>;
}

/**
 * Durable replay protection for signed acknowledgements.
 *
 * An in-memory nonce set forgets everything on restart, which lets a signed NACK be
 * replayed against a fresh process: the retry returns the row to `sent` and the replayed
 * NACK fails it again. Implementations of this interface must survive a restart.
 *
 * `claimAckNonce` is claim-once semantics: it returns true the first time a nonce is seen
 * and false for every subsequent call, so callers never need a separate check-then-write.
 */
export interface AckReceiptStore {
  claimAckNonce(senderAgentId: string, nonce: string): Promise<boolean>;
}

/** Non-durable fallback. Use only where a restart cannot happen (tests, one-shot tools). */
export class InMemoryAckReceiptStore implements AckReceiptStore {
  private readonly keys = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = Math.max(1, Math.floor(maxSize));
  }

  async claimAckNonce(senderAgentId: string, nonce: string): Promise<boolean> {
    const key = `${senderAgentId}:${nonce}`;
    if (this.keys.has(key)) return false;
    this.keys.set(key, true);
    if (this.keys.size > this.maxSize) {
      const oldest = this.keys.keys().next();
      if (!oldest.done) this.keys.delete(oldest.value);
    }
    return true;
  }
}

export class InMemoryDedupeStore implements DedupeStore {
  private readonly keys: Map<string, true>;
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.keys = new Map<string, true>();
    this.maxSize = Math.max(1, Math.floor(maxSize));
  }

  async seen(msgId: string, consumerId: string): Promise<boolean> {
    return this.keys.has(`${consumerId}:${msgId}`);
  }

  async markSeen(msgId: string, consumerId: string): Promise<void> {
    this.keys.set(`${consumerId}:${msgId}`, true);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.keys.size <= this.maxSize) return;
    const evictCount = Math.max(1, Math.ceil(this.maxSize * 0.1));
    const oldest = this.keys.keys();
    for (let i = 0; i < evictCount; i += 1) {
      const next = oldest.next();
      if (next.done) break;
      this.keys.delete(next.value);
    }
  }
}

interface JsonDedupeState {
  seen: string[];
}

const warnedJsonPaths = new Set<string>();
const warnIfJsonStoreMayRace = (filePath: string): void => {
  if (process.env.MURMUR_JSON_STORE_LOCKING === "1") return;
  if (warnedJsonPaths.has(filePath)) return;
  warnedJsonPaths.add(filePath);
  console.warn(
    `[murmur/core] JSON store at ${filePath} has no inter-process locking. Use single-process mode or set MURMUR_JSON_STORE_LOCKING=1 once external locking is guaranteed.`,
  );
};

export class JsonFileDedupeStore implements DedupeStore {
  private readonly filePath: string;

  constructor(filePath = ".data/dedupe.json") {
    this.filePath = filePath;
    warnIfJsonStoreMayRace(this.filePath);
  }

  private async load(): Promise<Set<string>> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as JsonDedupeState;
      return new Set(data.seen ?? []);
    } catch {
      return new Set();
    }
  }

  private async save(set: Set<string>): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const state: JsonDedupeState = { seen: [...set] };
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  async seen(msgId: string, consumerId: string): Promise<boolean> {
    const set = await this.load();
    return set.has(`${consumerId}:${msgId}`);
  }

  async markSeen(msgId: string, consumerId: string): Promise<void> {
    const set = await this.load();
    set.add(`${consumerId}:${msgId}`);
    await this.save(set);
  }
}

export type OutboxStatus = "pending" | "sent" | "acked" | "failed" | "dlq";

/**
 * Statuses a row can never be moved out of: the message is settled for good.
 *
 * `failed` is deliberately NOT here. A failed row is *scheduled for retry*, not
 * settled — `claimDue()` selects it on purpose. Listing it as terminal made the
 * retry unable to complete: claimDue re-selected the row, publish succeeded,
 * markSent() refused to touch it, so status stayed `failed`, `attempts` never
 * grew (no DLQ), `nextAttemptAt` stayed in the past (immediate re-claim), and
 * the returning ACK was rejected as message-not-in-flight. An infinite loop with
 * no way to settle it short of a manual dlq (#113).
 *
 * The race that put it here — a fast ACK landing between publish() and markSent(),
 * where a late markSent() would drag the settled row back into flight — is handled
 * by the `expectedVersion` compare-and-swap on markSent() instead. That guards the
 * row against *any* concurrent transition, not just the two statuses someone
 * remembered to enumerate.
 */
export const TERMINAL_OUTBOX_STATUSES: ReadonlySet<OutboxStatus> = new Set<OutboxStatus>([
  "acked",
  "dlq",
]);

export interface OutboxRecord {
  msgId: string;
  subject: string;
  envelope: EnvelopeV1;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  version?: number;
}

export interface OutboxStore {
  enqueue(subject: string, envelope: EnvelopeV1): Promise<void>;
  claimDue(limit?: number): Promise<OutboxRecord[]>;
  listInFlight?(): Promise<OutboxRecord[]>;
  getOutboxRecord(msgId: string): Promise<OutboxRecord | undefined>;
  /**
   * Move a claimed row into flight.
   *
   * Pass the `version` the row carried when `claimDue()` returned it: the update is
   * then applied only while the row is untouched, so an ACK/NACK that landed between
   * publish() and this call keeps its verdict instead of being overwritten with
   * `sent`. Omitting it keeps the old best-effort behaviour (settled rows are still
   * protected) and is only appropriate outside the claim → publish → mark path.
   */
  markSent(msgId: string, expectedVersion?: number): Promise<void>;
  markAcked(msgId: string): Promise<void>;
  markFailed(msgId: string, error: string, nextAttemptAt: string): Promise<void>;
  markDlq(msgId: string, error: string): Promise<void>;
  applyAckTransition(
    msgId: string,
    status: AckV1["status"],
    error?: string,
    nextAttemptAt?: string,
  ): Promise<"applied" | "not-found" | "not-in-flight">;
  requeueStaleSent?(ackTimeoutMs: number, reason?: string): Promise<number>;
}

interface JsonOutboxState {
  records: OutboxRecord[];
}

export class JsonFileOutboxStore implements OutboxStore {
  constructor(private readonly filePath = ".data/outbox.json") {
    warnIfJsonStoreMayRace(this.filePath);
  }

  private async load(): Promise<JsonOutboxState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as JsonOutboxState;
    } catch {
      return { records: [] };
    }
  }

  private async save(state: JsonOutboxState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  async enqueue(subject: string, envelope: EnvelopeV1): Promise<void> {
    const state = await this.load();
    if (state.records.find((r) => r.msgId === envelope.msgId)) return;

    const now = new Date().toISOString();
    state.records.push({
      msgId: envelope.msgId,
      subject,
      envelope,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await this.save(state);
  }

  async claimDue(limit = 50): Promise<OutboxRecord[]> {
    const state = await this.load();
    const now = Date.now();
    return state.records
      .filter((r) => ["pending", "failed"].includes(r.status) && new Date(r.nextAttemptAt).getTime() <= now)
      .slice(0, limit);
  }

  async listInFlight(): Promise<OutboxRecord[]> {
    const state = await this.load();
    return state.records.filter((r) => r.status === "sent");
  }

  async getOutboxRecord(msgId: string): Promise<OutboxRecord | undefined> {
    const state = await this.load();
    return state.records.find((record) => record.msgId === msgId);
  }

  async markSent(msgId: string, expectedVersion?: number): Promise<void> {
    const state = await this.load();
    const row = state.records.find((r) => r.msgId === msgId);
    if (!row) return;
    // A settled row is never dragged back into flight.
    if (TERMINAL_OUTBOX_STATUSES.has(row.status)) return;
    // Compare-and-swap against the version claimDue() handed out: if anything moved the
    // row since (a fast ACK/NACK between publish() and this call), that verdict wins.
    if (expectedVersion !== undefined && (row.version ?? 1) !== expectedVersion) return;
    row.status = "sent";
    row.attempts += 1;
    row.updatedAt = new Date().toISOString();
    row.version = (row.version ?? 0) + 1;
    await this.save(state);
  }

  async markAcked(msgId: string): Promise<void> {
    const state = await this.load();
    const row = state.records.find((r) => r.msgId === msgId);
    if (!row) return;
    row.status = "acked";
    row.updatedAt = new Date().toISOString();
    row.version = (row.version ?? 0) + 1;
    await this.save(state);
  }

  async markFailed(msgId: string, error: string, nextAttemptAt: string): Promise<void> {
    const state = await this.load();
    const row = state.records.find((r) => r.msgId === msgId);
    if (!row) return;
    row.status = "failed";
    row.lastError = error;
    row.nextAttemptAt = nextAttemptAt;
    row.updatedAt = new Date().toISOString();
    row.version = (row.version ?? 0) + 1;
    await this.save(state);
  }

  async markDlq(msgId: string, error: string): Promise<void> {
    const state = await this.load();
    const row = state.records.find((r) => r.msgId === msgId);
    if (!row) return;
    row.status = "dlq";
    row.lastError = error;
    row.updatedAt = new Date().toISOString();
    row.version = (row.version ?? 0) + 1;
    await this.save(state);
  }

  async applyAckTransition(
    msgId: string,
    status: AckV1["status"],
    error = "nack",
    nextAttemptAt = new Date().toISOString(),
  ): Promise<"applied" | "not-found" | "not-in-flight"> {
    const state = await this.load();
    const row = state.records.find((record) => record.msgId === msgId);
    if (!row) return "not-found";
    // See the SQLite implementation: 'pending' is accepted so a fast ACK arriving between
    // publish() and markSent() is not rejected into a spurious retry.
    if (row.status !== "sent" && row.status !== "pending") return "not-in-flight";

    const now = new Date().toISOString();
    if (status === "ack") {
      row.status = "acked";
    } else {
      row.status = "failed";
      row.lastError = error;
      row.nextAttemptAt = nextAttemptAt;
    }
    row.updatedAt = now;
    row.version = (row.version ?? 0) + 1;
    await this.save(state);
    return "applied";
  }

  async requeueStaleSent(ackTimeoutMs: number, reason = "ack-timeout"): Promise<number> {
    const state = await this.load();
    const now = Date.now();
    let changed = 0;
    for (const row of state.records) {
      if (row.status !== "sent") continue;
      const ageMs = now - new Date(row.updatedAt).getTime();
      if (ageMs < ackTimeoutMs) continue;
      row.status = "failed";
      row.lastError = reason;
      row.nextAttemptAt = new Date(now).toISOString();
      row.updatedAt = new Date(now).toISOString();
      row.version = (row.version ?? 0) + 1;
      changed += 1;
    }
    if (changed > 0) {
      await this.save(state);
    }
    return changed;
  }
}

const ensureDir = (filePath: string): void => {
  if (filePath === ":memory:" || filePath.startsWith("file::memory:")) return;
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStats = lstatSync(dir);
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    throw new Error(`sqlite-state-directory-invalid:${dir}`);
  }
  if (typeof process.getuid === "function" && dirStats.uid !== process.getuid()) {
    throw new Error(`sqlite-state-directory-owner-mismatch:${dir}`);
  }

  if (existsSync(filePath)) {
    const fileStats = lstatSync(filePath);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error(`sqlite-state-file-invalid:${filePath}`);
    }
    if (typeof process.getuid === "function" && fileStats.uid !== process.getuid()) {
      throw new Error(`sqlite-state-file-owner-mismatch:${filePath}`);
    }
  }
};

const secureSqliteFiles = (filePath: string): void => {
  if (filePath === ":memory:" || filePath.startsWith("file::memory:")) return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
};

export class SQLiteDedupeOutboxStore implements DedupeStore, OutboxStore, AckReceiptStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = ".data/murmur.db") {
    ensureDir(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS dedupe_seen (
        consumer_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (consumer_id, msg_id)
      );
      CREATE TABLE IF NOT EXISTS ack_receipts (
        sender_agent_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (sender_agent_id, nonce)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        msg_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);
    `);
    secureSqliteFiles(dbPath);
  }

  async seen(msgId: string, consumerId: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM dedupe_seen WHERE consumer_id = ? AND msg_id = ? LIMIT 1")
      .get(consumerId, msgId) as { 1: number } | undefined;
    return !!row;
  }

  async markSeen(msgId: string, consumerId: string): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO dedupe_seen (consumer_id, msg_id, seen_at) VALUES (?, ?, ?)",
      )
      .run(consumerId, msgId, new Date().toISOString());
  }

  /**
   * Claim-once on `(sender_agent_id, nonce)`, durable across restarts.
   *
   * The PRIMARY KEY does the work: `INSERT OR IGNORE` reports zero changes when the nonce
   * was already claimed, so a replayed ACK is rejected even by a process that never saw
   * the original.
   */
  async claimAckNonce(senderAgentId: string, nonce: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO ack_receipts (sender_agent_id, nonce, claimed_at) VALUES (?, ?, ?)",
      )
      .run(senderAgentId, nonce, new Date().toISOString());
    return Number(result.changes ?? 0) > 0;
  }

  async enqueue(subject: string, envelope: EnvelopeV1): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox
        (msg_id, subject, envelope_json, status, attempts, next_attempt_at, created_at, updated_at, version)
        VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, 1)`,
      )
      .run(envelope.msgId, subject, JSON.stringify(envelope), now, now, now);
  }

  async claimDue(limit = 50): Promise<OutboxRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`,
      )
      .all(new Date().toISOString(), limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.toOutboxRecord(row));
  }

  async listInFlight(): Promise<OutboxRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE status = 'sent' ORDER BY updated_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.toOutboxRecord(row));
  }

  async getOutboxRecord(msgId: string): Promise<OutboxRecord | undefined> {
    return this.getOutboxRow(msgId);
  }

  async markSent(msgId: string, expectedVersion?: number): Promise<void> {
    // Single statement, so the guard and the write cannot be split by a concurrent
    // transition. A settled row (acked/dlq) is never dragged back into flight, and when
    // the caller passes the version claimDue() handed out, an ACK/NACK that landed
    // between publish() and this call keeps its verdict — see the JSON store.
    const terminal = [...TERMINAL_OUTBOX_STATUSES];
    const placeholders = terminal.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'sent', attempts = attempts + 1, updated_at = ?, version = version + 1
         WHERE msg_id = ?
           AND status NOT IN (${placeholders})
           AND (? IS NULL OR version = ?)`,
      )
      .run(
        new Date().toISOString(),
        msgId,
        ...terminal,
        expectedVersion ?? null,
        expectedVersion ?? null,
      );
  }

  async markAcked(msgId: string): Promise<void> {
    await this.updateOutboxOptimistic(msgId, () => ({
      status: "acked",
      updatedAt: new Date().toISOString(),
    }));
  }

  async markFailed(msgId: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.updateOutboxOptimistic(msgId, () => ({
      status: "failed",
      lastError: error,
      nextAttemptAt,
      updatedAt: new Date().toISOString(),
    }));
  }

  async markDlq(msgId: string, error: string): Promise<void> {
    await this.updateOutboxOptimistic(msgId, () => ({
      status: "dlq",
      lastError: error,
      updatedAt: new Date().toISOString(),
    }));
  }

  async applyAckTransition(
    msgId: string,
    status: AckV1["status"],
    error = "nack",
    nextAttemptAt = new Date().toISOString(),
  ): Promise<"applied" | "not-found" | "not-in-flight"> {
    const now = new Date().toISOString();
    const nextStatus = status === "ack" ? "acked" : "failed";
    const nextError = status === "ack" ? null : error;
    // 'pending' is accepted alongside 'sent' on purpose: a fast peer can acknowledge
    // between publish() and markSent(), and rejecting that ACK leaves the row to time out
    // into a spurious retry. markSent() refuses to downgrade a terminal status, so the
    // late markSent() cannot overwrite the transition applied here.
    const changed = this.db
      .prepare(
        `UPDATE outbox
         SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?, version = version + 1
         WHERE msg_id = ? AND status IN ('sent', 'pending')`,
      )
      .run(nextStatus, nextError, nextAttemptAt, now, msgId);
    if (changed.changes > 0) return "applied";
    return this.getOutboxRow(msgId) ? "not-in-flight" : "not-found";
  }

  async requeueStaleSent(ackTimeoutMs: number, reason = "ack-timeout"): Promise<number> {
    const threshold = new Date(Date.now() - ackTimeoutMs).toISOString();
    const res = this.db
      .prepare(
        `UPDATE outbox
         SET status = 'failed',
             last_error = ?,
             next_attempt_at = ?,
             updated_at = ?,
             version = version + 1
         WHERE status = 'sent' AND updated_at <= ?`,
      )
      .run(reason, new Date().toISOString(), new Date().toISOString(), threshold);
    return Number(res.changes ?? 0);
  }

  private toOutboxRecord(row: Record<string, unknown>): OutboxRecord {
    return {
      msgId: String(row.msg_id),
      subject: String(row.subject),
      envelope: JSON.parse(String(row.envelope_json)) as EnvelopeV1,
      status: String(row.status) as OutboxStatus,
      attempts: Number(row.attempts),
      nextAttemptAt: String(row.next_attempt_at),
      lastError: row.last_error ? String(row.last_error) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      version: Number(row.version),
    };
  }

  private getOutboxRow(msgId: string): OutboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM outbox WHERE msg_id = ?").get(msgId) as Record<string, unknown> | undefined;
    return row ? this.toOutboxRecord(row) : undefined;
  }

  private async updateOutboxOptimistic(
    msgId: string,
    mutate: (current: OutboxRecord) => Partial<OutboxRecord>,
  ): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const current = this.getOutboxRow(msgId);
      if (!current) return;

      const patch = mutate(current);
      const nextStatus = patch.status ?? current.status;
      const nextAttempts = patch.attempts ?? current.attempts;
      const nextNextAttemptAt = patch.nextAttemptAt ?? current.nextAttemptAt;
      const nextLastError = patch.lastError ?? current.lastError ?? null;
      const nextUpdatedAt = patch.updatedAt ?? new Date().toISOString();
      const changed = this.db
        .prepare(
          `UPDATE outbox
           SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?, version = version + 1
           WHERE msg_id = ? AND version = ?`,
        )
        .run(
          nextStatus,
          nextAttempts,
          nextNextAttemptAt,
          nextLastError,
          nextUpdatedAt,
          msgId,
          current.version ?? 1,
        );

      if (changed.changes > 0) return;
    }
    throw new Error(`optimistic-lock-failed: ${msgId}`);
  }
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export class PgSqlExecutor implements SqlExecutor {
  private readonly poolPromise: Promise<import("pg").Pool>;

  constructor(private readonly connectionString: string) {
    this.poolPromise = import("pg").then(({ Pool }) => new Pool({ connectionString: this.connectionString }));
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const pool = await this.poolPromise;
    const res = await pool.query(sql, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    const pool = await this.poolPromise;
    await pool.end();
  }
}

export interface LocalMessageRecord {
  id: string;
  conversationId: string;
  msgId: string;
  direction: "inbound" | "outbound";
  sender: string;
  text: string;
  createdAt: string;
  transport?: string;
}

/**
 * Lifecycle stage of a single message, recorded independently of transport
 * delivery. The outbox proves an envelope was *handed to the broker*; these
 * events prove what happened *after* — whether a peer actually woke, handled
 * it, and answered.
 *
 * Delivery progress is not processing success: a durable cursor shows an event
 * was received, never that it was trusted, acted on, or acknowledged complete.
 */
export type MessageEventKind =
  | "queued"       // accepted locally, handed to the outbox
  | "delivered"    // transport confirmed handoff (broker ack)
  | "woke"         // recipient session was actually woken
  | "wake_failed"  // wake attempted and refused — delivered but nobody is listening
  | "handled"      // recipient processed it
  | "replied"      // recipient answered; relatesTo carries the answering msgId
  | "failed";      // terminal failure, detail carries the reason

export interface MessageEventRecord {
  id: string;
  msgId: string;
  conversationId?: string;
  event: MessageEventKind;
  actor?: string;
  detail?: string;
  /** For `replied`: the msgId of the answer. For others: a correlated msgId. */
  relatesTo?: string;
  createdAt: string;
}

export class SQLiteMessageStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = ".data/murmur.db") {
    ensureDir(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        transport TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_local_messages_conversation ON local_messages(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_messages_text ON local_messages(text);

      CREATE TABLE IF NOT EXISTS message_events (
        id TEXT PRIMARY KEY,
        msg_id TEXT NOT NULL,
        conversation_id TEXT,
        event TEXT NOT NULL,
        actor TEXT,
        detail TEXT,
        relates_to TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_events_msg ON message_events(msg_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_events_conversation ON message_events(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_events_relates ON message_events(relates_to);
    `);
    secureSqliteFiles(dbPath);
  }

  /**
   * Append a lifecycle event. Additive and idempotent-safe: events accumulate,
   * nothing is overwritten, so a trace stays readable even when a message goes
   * delivered → wake_failed → (retry) → woke → handled.
   */
  async recordEvent(input: Omit<MessageEventRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<MessageEventRecord> {
    const row: MessageEventRecord = {
      id: randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO message_events
         (id, msg_id, conversation_id, event, actor, detail, relates_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.msgId,
        row.conversationId ?? null,
        row.event,
        row.actor ?? null,
        row.detail ?? null,
        row.relatesTo ?? null,
        row.createdAt,
      );
    return row;
  }

  /** Full lifecycle of one message, oldest first — the answer to "what happened to it". */
  async traceMessage(msgId: string): Promise<MessageEventRecord[]> {
    return this.db
      .prepare(
        `SELECT
           id,
           msg_id as msgId,
           conversation_id as conversationId,
           event,
           actor,
           detail,
           relates_to as relatesTo,
           created_at as createdAt
         FROM message_events
         WHERE msg_id = ?
         ORDER BY created_at ASC`,
      )
      .all(msgId) as unknown as MessageEventRecord[];
  }

  /** Lifecycle across a conversation, newest first. */
  async traceConversation(conversationId: string, limit = 100): Promise<MessageEventRecord[]> {
    return this.db
      .prepare(
        `SELECT
           id,
           msg_id as msgId,
           conversation_id as conversationId,
           event,
           actor,
           detail,
           relates_to as relatesTo,
           created_at as createdAt
         FROM message_events
         WHERE conversation_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as MessageEventRecord[];
  }

  /**
   * Outbound messages that were delivered but never answered — the question
   * "who is silently ignoring me" that transport metrics cannot answer.
   * A message counts as stalled when it has no `replied` event and its newest
   * event is older than `olderThanIso`.
   */
  async stalledOutbound(olderThanIso: string, limit = 50): Promise<Array<{ msgId: string; conversationId: string | null; lastEvent: string; lastEventAt: string }>> {
    return this.db
      .prepare(
        `SELECT
           e.msg_id as msgId,
           e.conversation_id as conversationId,
           e.event as lastEvent,
           e.created_at as lastEventAt
         FROM message_events e
         JOIN (
           SELECT msg_id, MAX(created_at) as newest
           FROM message_events
           GROUP BY msg_id
         ) latest ON latest.msg_id = e.msg_id AND latest.newest = e.created_at
         WHERE e.created_at < ?
           AND e.msg_id NOT IN (SELECT msg_id FROM message_events WHERE event = 'replied')
         ORDER BY e.created_at ASC
         LIMIT ?`,
      )
      .all(olderThanIso, limit) as unknown as Array<{ msgId: string; conversationId: string | null; lastEvent: string; lastEventAt: string }>;
  }

  async append(input: Omit<LocalMessageRecord, "id">): Promise<LocalMessageRecord> {
    const row: LocalMessageRecord = { id: randomUUID(), ...input };
    this.db
      .prepare(
        `INSERT INTO local_messages
         (id, conversation_id, msg_id, direction, sender, text, created_at, transport)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.conversationId,
        row.msgId,
        row.direction,
        row.sender,
        row.text,
        row.createdAt,
        row.transport ?? null,
      );
    return row;
  }

  async listConversations(limit = 50): Promise<Array<{ conversationId: string; lastMessageAt: string; messageCount: number }>> {
    const rows = this.db
      .prepare(
        `SELECT conversation_id as conversationId, MAX(created_at) as lastMessageAt, COUNT(*) as messageCount
         FROM local_messages
         GROUP BY conversation_id
         ORDER BY lastMessageAt DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ conversationId: string; lastMessageAt: string; messageCount: number }>;
    return rows;
  }

  async getInboundAfter(conversationId: string, afterTimestamp: string, limit = 10): Promise<LocalMessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           conversation_id as conversationId,
           msg_id as msgId,
           direction,
           sender,
           text,
           created_at as createdAt,
           transport
         FROM local_messages
         WHERE conversation_id = ? AND direction = 'inbound' AND created_at > ?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(conversationId, afterTimestamp, limit) as unknown as LocalMessageRecord[];
    return rows;
  }

  async searchMessages(query: string, limit = 50): Promise<LocalMessageRecord[]> {
    const q = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT
           id,
           conversation_id as conversationId,
           msg_id as msgId,
           direction,
           sender,
           text,
           created_at as createdAt,
           transport
         FROM local_messages
         WHERE text LIKE ? OR sender LIKE ? OR conversation_id LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(q, q, q, limit) as unknown as LocalMessageRecord[];
    return rows;
  }
}

export type StreamFrameKind = "stream.start" | "stream.chunk" | "stream.end";

export interface StreamStart {
  kind: "stream.start";
  streamId: string;
  chunkCount: number;
  totalBytes: number;
  contentType?: string;
  startedAt?: string;
}

export interface StreamChunk {
  kind: "stream.chunk";
  streamId: string;
  chunkIndex: number;
  chunkCount: number;
  data: string;
  sha256?: string;
  isLast: boolean;
}

export interface StreamEnd {
  kind: "stream.end";
  streamId: string;
  chunkCount: number;
  totalBytes: number;
  digest?: string;
  sha256?: string;
}

export type StreamFrame = StreamStart | StreamChunk | StreamEnd;

const isFiniteNumber = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);

/**
 * Structural type guards for the stream wire frames. Pure shape checks (the
 * canonical structural contract a cross-language implementation must satisfy),
 * mirroring {@link isEnvelopeV1}. They do NOT validate stream semantics
 * (chunkIndex bounds, totalBytes vs data, digest match) — that is the
 * reassembler's job. The conformance suite asserts these agree with
 * schema/protocol-v1.schema.json so spec and runtime can't drift.
 */
export const isStreamStart = (v: unknown): v is StreamStart => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.kind === "stream.start" &&
    typeof o.streamId === "string" && o.streamId.length > 0 &&
    isFiniteNumber(o.chunkCount) &&
    isFiniteNumber(o.totalBytes) &&
    (o.contentType === undefined || typeof o.contentType === "string") &&
    (o.startedAt === undefined || typeof o.startedAt === "string")
  );
};

export const isStreamChunk = (v: unknown): v is StreamChunk => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.kind === "stream.chunk" &&
    typeof o.streamId === "string" && o.streamId.length > 0 &&
    isFiniteNumber(o.chunkIndex) &&
    isFiniteNumber(o.chunkCount) &&
    typeof o.data === "string" && o.data.length > 0 &&
    (o.sha256 === undefined || typeof o.sha256 === "string") &&
    typeof o.isLast === "boolean"
  );
};

export const isStreamEnd = (v: unknown): v is StreamEnd => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.kind === "stream.end" &&
    typeof o.streamId === "string" && o.streamId.length > 0 &&
    isFiniteNumber(o.chunkCount) &&
    isFiniteNumber(o.totalBytes) &&
    (o.digest === undefined || typeof o.digest === "string") &&
    (o.sha256 === undefined || typeof o.sha256 === "string")
  );
};

export const isStreamFrame = (v: unknown): v is StreamFrame =>
  isStreamStart(v) || isStreamChunk(v) || isStreamEnd(v);

export interface ChunkStreamTextInput {
  streamId: string;
  text: string;
  maxChunkBytes: number;
}

export interface CreateStreamStartInput {
  streamId: string;
  chunkCount: number;
  totalBytes: number;
  contentType?: string;
  startedAt?: string;
}

export interface CreateStreamChunkInput {
  streamId: string;
  chunkIndex: number;
  chunkCount: number;
  data: string;
  sha256?: string;
}

export interface CreateStreamEndInput {
  streamId: string;
  chunkCount: number;
  totalBytes: number;
  digest?: string;
  sha256?: string;
}

export interface StreamReassemblyResult {
  status: "pending" | "duplicate" | "complete";
  streamId: string;
  receivedChunks: number;
  chunkCount: number;
  text?: string;
  sha256?: string;
}

export interface StreamReassemblyState {
  streamId: string;
  chunkCount: number;
  receivedChunks: number;
  sha256?: string;
}

export interface StreamBackpressureWindow {
  inFlightChunks: number;
  inFlightBytes: number;
  nextChunkBytes: number;
  maxInFlightChunks: number;
  maxInFlightBytes: number;
}

const textEncoder = new TextEncoder();

const utf8Bytes = (value: string): number => textEncoder.encode(value).byteLength;

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const isSha256Hex = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);

const assertSha256 = (name: string, value: string): void => {
  if (!isSha256Hex(value)) throw new Error(`${name}-invalid`);
};

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name}-invalid`);
};

const assertNonNegativeInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name}-invalid`);
};

export const createStreamStart = (input: CreateStreamStartInput): StreamStart => {
  if (!input.streamId) throw new Error("stream-id-required");
  assertPositiveInteger("stream-chunk-count", input.chunkCount);
  assertNonNegativeInteger("stream-total-bytes", input.totalBytes);
  if (input.contentType !== undefined && input.contentType.length === 0) throw new Error("stream-content-type-invalid");
  if (input.startedAt !== undefined && Number.isNaN(Date.parse(input.startedAt))) throw new Error("stream-started-at-invalid");

  return {
    kind: "stream.start",
    streamId: input.streamId,
    chunkCount: input.chunkCount,
    totalBytes: input.totalBytes,
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
  };
};

export const createStreamChunk = (input: CreateStreamChunkInput): StreamChunk => {
  if (!input.streamId) throw new Error("stream-id-required");
  assertNonNegativeInteger("stream-chunk-index", input.chunkIndex);
  assertPositiveInteger("stream-chunk-count", input.chunkCount);
  if (input.chunkIndex >= input.chunkCount) throw new Error("stream-chunk-index-out-of-range");
  if (input.data.length === 0) throw new Error("stream-chunk-data-required");
  const computedSha256 = sha256Hex(input.data);
  if (input.sha256 !== undefined) {
    assertSha256("stream-chunk-sha256", input.sha256);
    if (input.sha256 !== computedSha256) throw new Error(`stream-chunk-sha256-mismatch:${input.streamId}:${input.chunkIndex}`);
  }

  return {
    kind: "stream.chunk",
    streamId: input.streamId,
    chunkIndex: input.chunkIndex,
    chunkCount: input.chunkCount,
    data: input.data,
    sha256: input.sha256 ?? computedSha256,
    isLast: input.chunkIndex === input.chunkCount - 1,
  };
};

export const createStreamEnd = (input: CreateStreamEndInput): StreamEnd => {
  if (!input.streamId) throw new Error("stream-id-required");
  assertPositiveInteger("stream-chunk-count", input.chunkCount);
  assertNonNegativeInteger("stream-total-bytes", input.totalBytes);
  if (input.digest !== undefined && input.digest.length === 0) throw new Error("stream-digest-invalid");
  if (input.sha256 !== undefined) assertSha256("stream-sha256", input.sha256);

  return {
    kind: "stream.end",
    streamId: input.streamId,
    chunkCount: input.chunkCount,
    totalBytes: input.totalBytes,
    ...(input.digest !== undefined ? { digest: input.digest } : {}),
    ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
  };
};

export const chunkStreamText = (input: ChunkStreamTextInput): StreamChunk[] => {
  if (!input.streamId) throw new Error("stream-id-required");
  assertPositiveInteger("stream-max-chunk-bytes", input.maxChunkBytes);
  if (input.text.length === 0) throw new Error("stream-text-required");

  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const symbol of input.text) {
    const symbolBytes = utf8Bytes(symbol);
    if (symbolBytes > input.maxChunkBytes) throw new Error("stream-symbol-exceeds-max-chunk-bytes");
    if (current && currentBytes + symbolBytes > input.maxChunkBytes) {
      parts.push(current);
      current = symbol;
      currentBytes = symbolBytes;
    } else {
      current += symbol;
      currentBytes += symbolBytes;
    }
  }

  if (current) parts.push(current);
  return parts.map((data, index) => createStreamChunk({
    streamId: input.streamId,
    chunkIndex: index,
    chunkCount: parts.length,
    data,
  }));
};

export class InMemoryStreamReassembler {
  private readonly streams = new Map<string, { chunkCount: number; chunks: Map<number, string>; endSha256?: string }>();

  acceptEnd(end: StreamEnd): StreamReassemblyResult {
    this.validateEnd(end);
    let state = this.streams.get(end.streamId);
    if (!state) {
      state = { chunkCount: end.chunkCount, chunks: new Map<number, string>(), endSha256: end.sha256 };
      this.streams.set(end.streamId, state);
    } else {
      if (state.chunkCount !== end.chunkCount) throw new Error(`stream-chunk-count-conflict:${end.streamId}`);
      if (state.endSha256 !== undefined && end.sha256 !== undefined && state.endSha256 !== end.sha256) {
        throw new Error(`stream-sha256-conflict:${end.streamId}`);
      }
      state.endSha256 = state.endSha256 ?? end.sha256;
    }

    return this.completeIfReady(end.streamId, state);
  }

  accept(chunk: StreamChunk): StreamReassemblyResult {
    this.validateChunk(chunk);
    let state = this.streams.get(chunk.streamId);
    if (!state) {
      state = { chunkCount: chunk.chunkCount, chunks: new Map<number, string>() };
      this.streams.set(chunk.streamId, state);
    } else if (state.chunkCount !== chunk.chunkCount) {
      throw new Error(`stream-chunk-count-conflict:${chunk.streamId}`);
    }

    const existing = state.chunks.get(chunk.chunkIndex);
    if (existing !== undefined) {
      if (existing !== chunk.data) throw new Error(`stream-chunk-conflict:${chunk.streamId}:${chunk.chunkIndex}`);
      return {
        status: "duplicate",
        streamId: chunk.streamId,
        receivedChunks: state.chunks.size,
        chunkCount: state.chunkCount,
      };
    }

    state.chunks.set(chunk.chunkIndex, chunk.data);
    return this.completeIfReady(chunk.streamId, state);
  }

  get(streamId: string): StreamReassemblyState | undefined {
    const state = this.streams.get(streamId);
    if (!state) return undefined;
    return {
      streamId,
      chunkCount: state.chunkCount,
      receivedChunks: state.chunks.size,
      ...(state.endSha256 !== undefined ? { sha256: state.endSha256 } : {}),
    };
  }

  delete(streamId: string): boolean {
    return this.streams.delete(streamId);
  }

  clear(): void {
    this.streams.clear();
  }

  private validateChunk(chunk: StreamChunk): void {
    if (chunk.kind !== "stream.chunk") throw new Error("stream-chunk-kind-invalid");
    if (!chunk.streamId) throw new Error("stream-id-required");
    assertNonNegativeInteger("stream-chunk-index", chunk.chunkIndex);
    assertPositiveInteger("stream-chunk-count", chunk.chunkCount);
    if (chunk.chunkIndex >= chunk.chunkCount) throw new Error("stream-chunk-index-out-of-range");
    if (chunk.data.length === 0) throw new Error("stream-chunk-data-required");
    if (chunk.isLast !== (chunk.chunkIndex === chunk.chunkCount - 1)) throw new Error("stream-chunk-last-flag-invalid");
    if (chunk.sha256 !== undefined) {
      assertSha256("stream-chunk-sha256", chunk.sha256);
      if (chunk.sha256 !== sha256Hex(chunk.data)) throw new Error(`stream-chunk-sha256-mismatch:${chunk.streamId}:${chunk.chunkIndex}`);
    }
  }

  private validateEnd(end: StreamEnd): void {
    if (end.kind !== "stream.end") throw new Error("stream-end-kind-invalid");
    if (!end.streamId) throw new Error("stream-id-required");
    assertPositiveInteger("stream-chunk-count", end.chunkCount);
    assertNonNegativeInteger("stream-total-bytes", end.totalBytes);
    if (end.sha256 !== undefined) assertSha256("stream-sha256", end.sha256);
  }

  private completeIfReady(
    streamId: string,
    state: { chunkCount: number; chunks: Map<number, string>; endSha256?: string },
  ): StreamReassemblyResult {
    if (state.chunks.size !== state.chunkCount) {
      return {
        status: "pending",
        streamId,
        receivedChunks: state.chunks.size,
        chunkCount: state.chunkCount,
      };
    }

    const text = Array.from({ length: state.chunkCount }, (_, index) => state.chunks.get(index) ?? "").join("");
    const actualSha256 = sha256Hex(text);
    if (state.endSha256 !== undefined && state.endSha256 !== actualSha256) {
      throw new Error(`stream-sha256-mismatch:${streamId}`);
    }
    this.streams.delete(streamId);
    return {
      status: "complete",
      streamId,
      receivedChunks: state.chunkCount,
      chunkCount: state.chunkCount,
      text,
      sha256: actualSha256,
    };
  }
}

export class SQLiteStreamReassembler {
  private readonly db: DatabaseSync;

  constructor(dbPath = ".data/murmur.db") {
    ensureDir(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS stream_reassembly_meta (
        stream_id TEXT PRIMARY KEY,
        chunk_count INTEGER NOT NULL,
        end_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stream_reassembly_chunks (
        stream_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        data TEXT NOT NULL,
        sha256 TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stream_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_stream_reassembly_chunks_stream ON stream_reassembly_chunks(stream_id);
    `);
    secureSqliteFiles(dbPath);
  }

  acceptEnd(end: StreamEnd): StreamReassemblyResult {
    this.validateEnd(end);
    this.ensureMeta(end.streamId, end.chunkCount, end.sha256);
    return this.completeIfReady(end.streamId);
  }

  accept(chunk: StreamChunk): StreamReassemblyResult {
    this.validateChunk(chunk);
    this.ensureMeta(chunk.streamId, chunk.chunkCount);
    const existing = this.db
      .prepare("SELECT data FROM stream_reassembly_chunks WHERE stream_id = ? AND chunk_index = ?")
      .get(chunk.streamId, chunk.chunkIndex) as { data: string } | undefined;

    if (existing) {
      if (existing.data !== chunk.data) throw new Error(`stream-chunk-conflict:${chunk.streamId}:${chunk.chunkIndex}`);
      const state = this.get(chunk.streamId);
      return {
        status: "duplicate",
        streamId: chunk.streamId,
        receivedChunks: state?.receivedChunks ?? 0,
        chunkCount: chunk.chunkCount,
      };
    }

    this.db
      .prepare(
        `INSERT INTO stream_reassembly_chunks
         (stream_id, chunk_index, chunk_count, data, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(chunk.streamId, chunk.chunkIndex, chunk.chunkCount, chunk.data, chunk.sha256 ?? null, new Date().toISOString());

    return this.completeIfReady(chunk.streamId);
  }

  get(streamId: string): StreamReassemblyState | undefined {
    const meta = this.getMeta(streamId);
    if (!meta) return undefined;
    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM stream_reassembly_chunks WHERE stream_id = ?")
      .get(streamId) as { count: number };
    return {
      streamId,
      chunkCount: meta.chunkCount,
      receivedChunks: Number(count.count),
      ...(meta.endSha256 !== undefined ? { sha256: meta.endSha256 } : {}),
    };
  }

  delete(streamId: string): boolean {
    const before = this.get(streamId);
    this.db.prepare("DELETE FROM stream_reassembly_chunks WHERE stream_id = ?").run(streamId);
    this.db.prepare("DELETE FROM stream_reassembly_meta WHERE stream_id = ?").run(streamId);
    return before !== undefined;
  }

  clear(): void {
    this.db.prepare("DELETE FROM stream_reassembly_chunks").run();
    this.db.prepare("DELETE FROM stream_reassembly_meta").run();
  }

  private ensureMeta(streamId: string, chunkCount: number, endSha256?: string): void {
    const existing = this.getMeta(streamId);
    const now = new Date().toISOString();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO stream_reassembly_meta
           (stream_id, chunk_count, end_sha256, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(streamId, chunkCount, endSha256 ?? null, now, now);
      return;
    }

    if (existing.chunkCount !== chunkCount) throw new Error(`stream-chunk-count-conflict:${streamId}`);
    if (existing.endSha256 !== undefined && endSha256 !== undefined && existing.endSha256 !== endSha256) {
      throw new Error(`stream-sha256-conflict:${streamId}`);
    }
    if (existing.endSha256 === undefined && endSha256 !== undefined) {
      this.db
        .prepare("UPDATE stream_reassembly_meta SET end_sha256 = ?, updated_at = ? WHERE stream_id = ?")
        .run(endSha256, now, streamId);
    }
  }

  private getMeta(streamId: string): { chunkCount: number; endSha256?: string } | undefined {
    const row = this.db
      .prepare("SELECT chunk_count as chunkCount, end_sha256 as endSha256 FROM stream_reassembly_meta WHERE stream_id = ?")
      .get(streamId) as { chunkCount: number; endSha256: string | null } | undefined;
    if (!row) return undefined;
    return {
      chunkCount: Number(row.chunkCount),
      ...(row.endSha256 ? { endSha256: row.endSha256 } : {}),
    };
  }

  private completeIfReady(streamId: string): StreamReassemblyResult {
    const meta = this.getMeta(streamId);
    if (!meta) throw new Error(`stream-state-missing:${streamId}`);
    const rows = this.db
      .prepare("SELECT chunk_index as chunkIndex, data FROM stream_reassembly_chunks WHERE stream_id = ? ORDER BY chunk_index ASC")
      .all(streamId) as Array<{ chunkIndex: number; data: string }>;
    if (rows.length !== meta.chunkCount) {
      return {
        status: "pending",
        streamId,
        receivedChunks: rows.length,
        chunkCount: meta.chunkCount,
      };
    }
    for (let index = 0; index < meta.chunkCount; index += 1) {
      if (Number(rows[index]?.chunkIndex) !== index) {
        return {
          status: "pending",
          streamId,
          receivedChunks: rows.length,
          chunkCount: meta.chunkCount,
        };
      }
    }

    const text = rows.map((row) => row.data).join("");
    const actualSha256 = sha256Hex(text);
    if (meta.endSha256 !== undefined && meta.endSha256 !== actualSha256) {
      throw new Error(`stream-sha256-mismatch:${streamId}`);
    }
    this.delete(streamId);
    return {
      status: "complete",
      streamId,
      receivedChunks: meta.chunkCount,
      chunkCount: meta.chunkCount,
      text,
      sha256: actualSha256,
    };
  }

  private validateChunk(chunk: StreamChunk): void {
    if (chunk.kind !== "stream.chunk") throw new Error("stream-chunk-kind-invalid");
    if (!chunk.streamId) throw new Error("stream-id-required");
    assertNonNegativeInteger("stream-chunk-index", chunk.chunkIndex);
    assertPositiveInteger("stream-chunk-count", chunk.chunkCount);
    if (chunk.chunkIndex >= chunk.chunkCount) throw new Error("stream-chunk-index-out-of-range");
    if (chunk.data.length === 0) throw new Error("stream-chunk-data-required");
    if (chunk.isLast !== (chunk.chunkIndex === chunk.chunkCount - 1)) throw new Error("stream-chunk-last-flag-invalid");
    if (chunk.sha256 !== undefined) {
      assertSha256("stream-chunk-sha256", chunk.sha256);
      if (chunk.sha256 !== sha256Hex(chunk.data)) throw new Error(`stream-chunk-sha256-mismatch:${chunk.streamId}:${chunk.chunkIndex}`);
    }
  }

  private validateEnd(end: StreamEnd): void {
    if (end.kind !== "stream.end") throw new Error("stream-end-kind-invalid");
    if (!end.streamId) throw new Error("stream-id-required");
    assertPositiveInteger("stream-chunk-count", end.chunkCount);
    assertNonNegativeInteger("stream-total-bytes", end.totalBytes);
    if (end.sha256 !== undefined) assertSha256("stream-sha256", end.sha256);
  }
}

export const streamBackpressureAllowsSend = (window: StreamBackpressureWindow): boolean => {
  assertNonNegativeInteger("stream-in-flight-chunks", window.inFlightChunks);
  assertNonNegativeInteger("stream-in-flight-bytes", window.inFlightBytes);
  assertPositiveInteger("stream-next-chunk-bytes", window.nextChunkBytes);
  assertPositiveInteger("stream-max-in-flight-chunks", window.maxInFlightChunks);
  assertPositiveInteger("stream-max-in-flight-bytes", window.maxInFlightBytes);

  return (
    window.inFlightChunks < window.maxInFlightChunks &&
    window.inFlightBytes + window.nextChunkBytes <= window.maxInFlightBytes
  );
};

export const isEnvelopeV1 = (v: unknown): v is EnvelopeV1 => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const hasOptional = (key: keyof EnvelopeV1, type: "string" | "number"): boolean => {
    const value = o[key as string];
    return value === undefined || typeof value === type;
  };

  return (
    o.schemaVersion === "1.0" &&
    typeof o.msgId === "string" && o.msgId.length > 0 &&
    typeof o.conversationId === "string" && o.conversationId.length > 0 &&
    typeof o.senderAgentId === "string" && o.senderAgentId.length > 0 &&
    Array.isArray(o.recipients) && o.recipients.length > 0 && o.recipients.every((r) => typeof r === "string" && r.length > 0) &&
    typeof o.createdAt === "string" && !Number.isNaN(Date.parse(o.createdAt)) &&
    typeof o.payloadCiphertext === "string" && o.payloadCiphertext.length > 0 &&
    typeof o.payloadNonce === "string" && o.payloadNonce.length > 0 &&
    typeof o.signature === "string" && o.signature.length > 0 &&
    hasOptional("ttlSeconds", "number") &&
    hasOptional("traceId", "string") &&
    hasOptional("sequence", "number") &&
    hasOptional("parentMsgId", "string") &&
    // authToken: optional, but if present must be a non-empty string (a bearer token)
    (o.authToken === undefined || (typeof o.authToken === "string" && o.authToken.length > 0))
  );
};

export const createAck = (
  msgId: string,
  consumerId: string,
  status: AckV1["status"],
  reason?: string,
): AckV1 => ({
  msgId,
  consumerId,
  status,
  reason,
  at: new Date().toISOString(),
});

export const createBoundAck = (
  envelope: EnvelopeV1,
  consumerId: string,
  status: SignedAckV1["status"],
  reason?: string,
): UnsignedAckV1 => ({
  ackVersion: "1.0",
  msgId: envelope.msgId,
  messageDigest: envelopeDigest(envelope),
  conversationId: envelope.conversationId,
  senderAgentId: consumerId,
  recipientAgentId: envelope.senderAgentId,
  status,
  ...(reason !== undefined ? { reason } : {}),
  at: new Date().toISOString(),
  nonce: randomUUID(),
});

export const computeBackoffMs = (attempt: number, baseMs = 500, maxMs = 60_000): number => {
  const raw = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(maxMs, raw);
};

export const applyJitter = (baseMs: number, jitterRatio = 0.2): number => {
  const ratio = Math.max(0, Math.min(1, jitterRatio));
  const min = Math.max(0, baseMs * (1 - ratio));
  const max = baseMs * (1 + ratio);
  return Math.round(min + Math.random() * (max - min));
};

export interface SecurityPolicy {
  maxPayloadBytes?: number;
  allowedRoutes?: Record<string, string[]>;
}

export const estimateBase64DecodedBytes = (base64: string): number => {
  const normalized = base64.replace(/\s+/g, "");
  if (normalized.length === 0) return 0;
  const padding = (normalized.match(/=+$/)?.[0].length ?? 0);
  return Math.floor((normalized.length * 3) / 4) - padding;
};

export const validateEnvelopePolicy = (envelope: EnvelopeV1, policy?: SecurityPolicy): string[] => {
  if (!policy) return [];
  const violations: string[] = [];

  if (typeof policy.maxPayloadBytes === "number") {
    const size = estimateBase64DecodedBytes(envelope.payloadCiphertext);
    if (size > policy.maxPayloadBytes) {
      violations.push(`payload-too-large:${size}>${policy.maxPayloadBytes}`);
    }
  }

  if (policy.allowedRoutes) {
    const allowed = policy.allowedRoutes[envelope.senderAgentId] ?? [];
    const denied = envelope.recipients.filter((r) => !allowed.includes(r));
    if (denied.length > 0) {
      violations.push(`recipient-not-allowed:${denied.join(",")}`);
    }
  }

  return violations;
};
