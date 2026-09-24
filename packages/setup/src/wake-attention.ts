import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, validAgentId } from './config.js';
import type { ServiceContext } from './types.js';

/** Acknowledge an unknown accepted outcome; never replay it or claim it was read. */
export async function dismissWake(c: ServiceContext, msgId: string, expectedAgent: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,150}$/.test(msgId) || !validAgentId(expectedAgent)) throw new Error('wake.selection-invalid');
  const lock = path.join(c.dataDir, '.setup-write.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const config = await loadConfig(c);
    if (config.agentId !== expectedAgent) throw new Error('wake.identity-changed');
    const file = await lstat(c.storePath);
    if (!file.isFile() || file.isSymbolicLink() || (typeof process.getuid === 'function' && file.uid !== process.getuid())) {
      throw new Error('wake.store-invalid');
    }
    const db = new DatabaseSync(c.storePath);
    try {
      db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
      const row = db.prepare("SELECT wake_batch_id FROM local_messages WHERE direction='inbound' AND msg_id=?").get(msgId);
      if (!row) throw new Error('wake.dismiss-not-eligible');
      const rows = db.prepare(`SELECT msg_id,wake_status,wake_error FROM local_messages WHERE direction='inbound'
        AND (msg_id=? OR (wake_batch_id IS NOT NULL AND wake_batch_id=?))`).all(msgId, row.wake_batch_id);
      if (rows.some(r => !['dlq', 'muted'].includes(String(r.wake_status)) || r.wake_error !== 'accepted-turn-unobservable')) {
        throw new Error('wake.dismiss-not-eligible');
      }
      const update = db.prepare("UPDATE local_messages SET wake_status='muted',wake_next_at=NULL,wake_updated_at=? WHERE direction='inbound' AND msg_id=?");
      for (const r of rows) update.run(new Date().toISOString(), r.msg_id);
      db.exec('COMMIT');
      return { schema: 'murmur.wake-dismiss/1', agentId: config.agentId, msgIds: rows.map(r => r.msg_id),
        status: 'muted', reason: 'accepted-turn-unobservable', executed: false, historyPreserved: true };
    } finally { db.close(); }
  } finally { await rmdir(lock); }
}
