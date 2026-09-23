import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, readJson, safeError, validAgentId } from './config.js';
import { writeState } from './state.js';
import type { ServiceContext } from './types.js';

const stateFile = (c: ServiceContext) => path.join(c.dataDir, 'outbox-attention.json');
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,150}$/.test(v);
const validToken = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
interface Saved { schema: 'murmur.outbox-dismissals/1'; agentId: string; records: Array<{ msgId: string; token: string }> }
type Row = { msgId: string; subject: string; attempts: number; createdAt: string; failedAt: string; error: string | null; version: number; peer: string | null };
const columns = `msg_id AS msgId,subject,attempts,created_at AS createdAt,updated_at AS failedAt,last_error AS error,version,
  json_extract(envelope_json,'$.recipients[0]') AS peer`;
const tokenFor = (row: Row) => createHash('sha256').update(JSON.stringify([
  row.msgId, row.subject, row.attempts, row.createdAt, row.failedAt, row.error, row.version, row.peer,
])).digest('hex');

async function saved(c: ServiceContext, agentId: string): Promise<Saved> {
  let value;
  try { value = await readJson(stateFile(c)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 'murmur.outbox-dismissals/1', agentId, records: [] };
    throw new Error('outbox.dismissals-unreadable');
  }
  if (value?.schema !== 'murmur.outbox-dismissals/1' || value.agentId !== agentId || !Array.isArray(value.records)
    || value.records.length > 1000 || value.records.some((r: any) => !validId(r?.msgId) || !validToken(r?.token))
    || new Set(value.records.map((r: any) => r.msgId)).size !== value.records.length) throw new Error('outbox.dismissals-invalid');
  return value;
}

/** Metadata only. A dismissal never changes transport state or implies delivery. */
export async function readOutboxAttention(c: ServiceContext, agentId: string, db: DatabaseSync) {
  const state = await saved(c, agentId), ignored = new Map(state.records.map(r => [r.msgId, r.token]));
  // Keep the native status response below its 256 KiB transport limit.
  const rows = db.prepare(`SELECT ${columns} FROM outbox WHERE status='dlq' ORDER BY updated_at DESC,msg_id LIMIT 201`).all() as unknown as Row[];
  if (rows.length > 200) throw new Error('outbox.attention-limit-exceeded');
  const items = rows.map(row => {
    if (!validId(row.msgId)) throw new Error('outbox.record-invalid');
    const token = tokenFor(row);
    return { msgId: row.msgId, peer: validAgentId(row.peer) ? row.peer : null,
      createdAt: row.createdAt, failedAt: row.failedAt, reason: safeError(row.error), attempts: row.attempts,
      token, dismissed: ignored.get(row.msgId) === token };
  });
  // Outstanding items stay first, so older failures cannot disappear behind recent dismissals.
  items.sort((a, b) => Number(a.dismissed) - Number(b.dismissed));
  const dismissed = items.filter(i => i.dismissed).length;
  return { schema: 'murmur.outbox-attention/1' as const, total: items.length, pending: items.length - dismissed,
    dismissed, items, truncated: false, unknownReason: null };
}

export async function listOutboxAttention(c: ServiceContext) {
  const config = await loadConfig(c), db = new DatabaseSync(c.storePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    return { agentId: config.agentId, ...await readOutboxAttention(c, config.agentId, db) };
  } finally { db.close(); }
}

/** Reversible local acknowledgement, serialized with setup writers. The outbox DB stays read-only. */
export async function setOutboxDismissed(c: ServiceContext, msgId: string, token: string, expectedAgent: string, dismissed: boolean) {
  if (!validId(msgId) || !validToken(token) || !validAgentId(expectedAgent)) throw new Error('outbox.selection-invalid');
  const lock = path.join(c.dataDir, '.setup-write.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const config = await loadConfig(c);
    if (config.agentId !== expectedAgent) throw new Error('outbox.identity-changed');
    const db = new DatabaseSync(c.storePath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000; BEGIN');
      const row = db.prepare(`SELECT ${columns} FROM outbox WHERE status='dlq' AND msg_id=?`).get(msgId) as Row | undefined;
      if (!row) throw new Error('outbox.record-not-found');
      if (tokenFor(row) !== token) throw new Error('outbox.record-changed');
      const state = await saved(c, config.agentId);
      const records = state.records.filter(r => r.msgId !== msgId);
      if (dismissed) records.push({ msgId, token });
      if (records.length > 1000) throw new Error('outbox.dismissals-limit-exceeded');
      if (JSON.stringify(records) !== JSON.stringify(state.records)) await writeState(c, stateFile(c), { ...state, records });
      return { schema: 'murmur.outbox-action/1' as const, agentId: config.agentId, msgId, token, dismissed,
        transportState: 'dlq' as const, historyPreserved: true, resent: false };
    } finally { db.close(); }
  } finally { await rmdir(lock); }
}
