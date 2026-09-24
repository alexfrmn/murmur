import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export interface OutboxAttentionRow {
  msgId: string; subject: string; attempts: number; createdAt: string; failedAt: string;
  error: string | null; version: number; peer: string | null;
}
export interface OutboxDismissals {
  schema: 'murmur.outbox-dismissals/1'; agentId: string; records: Array<{ msgId: string; token: string }>;
}
export const outboxAttentionToken = (row: OutboxAttentionRow): string => createHash('sha256').update(JSON.stringify([
  row.msgId, row.subject, row.attempts, row.createdAt, row.failedAt, row.error, row.version, row.peer,
])).digest('hex');

/** Shared by the read-only setup view and automatic recovery; no envelope text. */
export function readOutboxDismissals(file: string, agentId: string): OutboxDismissals {
  let value: OutboxDismissals;
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('invalid-file');
      value = JSON.parse(readFileSync(fd, 'utf8')) as OutboxDismissals;
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 'murmur.outbox-dismissals/1', agentId, records: [] };
    throw new Error('outbox.dismissals-unreadable');
  }
  if (value?.schema !== 'murmur.outbox-dismissals/1' || value.agentId !== agentId || !Array.isArray(value.records)
    || value.records.length > 1000 || value.records.some(r => !r || typeof r.msgId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,150}$/.test(r.msgId) || typeof r.token !== 'string' || !/^[a-f0-9]{64}$/.test(r.token))
    || new Set(value.records.map(r => r.msgId)).size !== value.records.length) throw new Error('outbox.dismissals-invalid');
  return value;
}
