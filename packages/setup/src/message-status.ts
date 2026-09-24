import type { DatabaseSync } from 'node:sqlite';

/** Older stores remain readable without a migration or an invented wake result. */
export function wakeColumns(db: DatabaseSync): string {
  const columns = new Set(db.prepare('PRAGMA table_info(local_messages)').all().map(row => row.name));
  return ['wake_status', 'wake_updated_at', 'wake_error'].map(name => columns.has(name) ? name : `NULL AS ${name}`).join(',');
}

export function assistantRead(wakeStatus: unknown): boolean | null {
  if (wakeStatus === 'handled') return true;
  return ['pending', 'inflight', 'failed', 'dlq', 'stored-only', 'muted'].includes(String(wakeStatus)) ? false : null;
}
