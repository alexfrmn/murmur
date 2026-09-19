import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import { loadConfig, readJson } from './config.js';
import { readStatus } from './status.js';
import { writeState } from './state.js';
import type { PlatformAdapter, ServiceContext } from './types.js';

/** Explicit local configuration mutation, serialized against other setup writers. */
export async function setWakeEnabled(context: ServiceContext, adapter: PlatformAdapter, enabled: boolean, apply = false) {
  const lock = path.join(context.dataDir, '.setup-write.lock');
  await mkdir(lock, { mode: 0o700 });
  let backup: string | null = null;
  try {
    const config = await loadConfig(context);
    if ((config.wake?.enabled !== false) !== enabled) {
      backup = path.join(context.dataDir, `agent-config.backup-${randomUUID()}.json`);
      await writeState(context, backup, config);
      await writeState(context, context.configPath, { ...config, wake: { ...config.wake, enabled } });
    }
  } finally { await rmdir(lock); }
  let applyError: string | null = null;
  if (apply) {
    try { await adapter.stop(context); await adapter.start(context); }
    catch { applyError = 'wake.service-apply-failed'; }
  }
  const status = await readStatus({ context, adapter });
  const effectiveEnabled = status.wake.effective.enabled;
  return { schema: 'murmur.wake/1', configuredEnabled: enabled, effectiveEnabled,
    restartRequired: effectiveEnabled !== enabled, backup, applyError };
}

/** Explicit read action only; merely displaying status never consumes unread state. */
export async function markInboxRead(context: ServiceContext) {
  const { DatabaseSync } = await import('node:sqlite');
  const config = await loadConfig(context);
  const db = new DatabaseSync(context.storePath, { readOnly: true });
  try {
    const rowid = Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS rowid FROM local_messages WHERE direction='inbound'").get()!.rowid);
    const state = { schema: 'murmur.read/1', agentId: config.agentId, rowid };
    await writeState(context, path.join(context.dataDir, 'read-state.json'), state);
    return state;
  } finally { db.close(); }
}
