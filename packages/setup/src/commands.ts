import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import { loadConfig, readJson } from './config.js';
import { readStatus } from './status.js';
import { assistantRead, wakeColumns } from './message-status.js';
import { writeState } from './state.js';
import type { PlatformAdapter, ServiceContext } from './types.js';

/** Observe the configured directory only; this does not prove a live daemon's log destination. */
export async function readLogPath(context: ServiceContext) {
  const config = await loadConfig(context);
  try {
    const dataDir = await realpath(context.dataDir);
    const logDir = await realpath(context.logDir);
    const relative = path.relative(dataDir, logDir);
    // Resolve aliases before containment checks; never open an unrelated directory as this profile's logs.
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      throw new Error('logs.path-outside-profile');
    }
    if (!(await stat(logDir)).isDirectory()) throw new Error('logs.not-directory');
    await access(logDir, constants.R_OK | constants.X_OK);
    return { schema: 'murmur.logs/1', agentId: config.agentId, dataDir,
      serviceName: context.serviceName, logDir, source: 'configured' };
  } catch (error) {
    if (error instanceof Error && ['logs.path-outside-profile', 'logs.not-directory'].includes(error.message)) throw error;
    switch ((error as NodeJS.ErrnoException).code) {
      case 'ENOENT': throw new Error('logs.directory-missing');
      case 'ENOTDIR': throw new Error('logs.not-directory');
      case 'EACCES': case 'EPERM': throw new Error('logs.directory-unreadable');
      default: throw new Error('logs.path-unavailable');
    }
  }
}

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
    try {
      if ((await readStatus({ context, adapter })).service.state === 'running-unmanaged') applyError = 'service.running-unmanaged';
      else { await adapter.stop(context); await adapter.start(context); }
    }
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

/** Return durable inbound rows without advancing the independent read cursor. */
export async function readInbox(context: ServiceContext, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('inbox.limit-invalid');
  const { DatabaseSync } = await import('node:sqlite');
  const config = await loadConfig(context);
  const db = new DatabaseSync(context.storePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const tip = Number((db.prepare("SELECT COALESCE(MAX(rowid),0) AS rowid FROM local_messages WHERE direction='inbound'").get() as any).rowid);
    let cursor: number | null = null;
    try {
      const state = await readJson(path.join(context.dataDir, 'read-state.json'));
      if (state.schema !== 'murmur.read/1' || state.agentId !== config.agentId || !Number.isSafeInteger(state.rowid)
        || state.rowid < 0 || state.rowid > tip) throw new Error('inbox.cursor-invalid');
      cursor = state.rowid;
    } catch { /* Reading messages must not invent or repair read state. */ }
    const unread = cursor === null ? null : Number((db.prepare("SELECT COUNT(*) AS n FROM local_messages WHERE direction='inbound' AND rowid>?").get(cursor) as any).n);
    const rows = db.prepare(`SELECT rowid,conversation_id AS conversationId,msg_id AS msgId,sender,text,
      created_at AS createdAt,transport,channel_id AS channelId,sender_member_id AS senderMemberId,
      addressee_member_id AS addresseeMemberId,${wakeColumns(db)} FROM local_messages WHERE direction='inbound'
      ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    db.exec('COMMIT');
    return { schema: 'murmur.inbox/1', agentId: config.agentId, readCursor: cursor,
      unread,
      messages: rows.map(({ rowid, ...row }) => ({ ...row, assistantRead: assistantRead(row.wake_status),
        unread: cursor === null ? null : Number(rowid) > cursor })) };
  } finally { db.close(); }
}
