// Local operator sink. A completed model turn is a draft, never permission to send it.
import { constants, closeSync, fsyncSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const failure = () => Object.assign(new Error('owner-review-source-invalid'), { retryable: false });

function binding(peer, payload) {
  if (!uuid.test(payload?.msgId ?? '') || !peer?.dataDir || !peer?.storePath
      || path.dirname(path.resolve(peer.storePath)) !== path.resolve(peer.dataDir)) throw failure();
  const db = new DatabaseSync(peer.storePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT sender, conversation_id, created_at FROM local_messages WHERE msg_id=? AND direction=\'inbound\'').get(payload.msgId);
    if (!row || row.sender !== payload.from || row.conversation_id !== payload.conversationId) throw failure();
    return { source_id: payload.msgId, peer: row.sender, conversation: row.conversation_id, source_date: row.created_at };
  } finally { db.close(); }
}

function read(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 131072 || (info.mode & 0o077) !== 0) throw failure();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export function readOwnerReview(peer, payload) {
  const source = binding(peer, payload);
  let record;
  try { record = read(path.join(peer.dataDir, `owner-inbox-${payload.msgId}.json`)); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (record.schema !== 'murmur.owner-review/1' || record.privacy !== 'owner-only-local'
      || record.peer_send_authorized !== false || record.native_final_relay !== 'suppress'
      || Object.entries(source).some(([key, value]) => record.source?.[key] !== value)) throw failure();
  return record;
}

export function persistOwnerReview(peer, payload, draft) {
  const source = binding(peer, payload);
  if (typeof draft !== 'string' || !draft.trim() || Buffer.byteLength(draft) > 65536) throw failure();
  const record = { schema: 'murmur.owner-review/1', privacy: 'owner-only-local', source,
    status: 'awaiting_review', next_actor: 'owner', observed_at: new Date().toISOString(),
    peer_reply_draft: draft, owner_decision: null, peer_send_authorized: false,
    peer_delivery: null, native_final_relay: 'suppress' };
  const file = path.join(peer.dataDir, `owner-inbox-${payload.msgId}.json`);
  let fd;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (err) { if (err.code === 'EEXIST') return readOwnerReview(peer, payload); throw err; }
  try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  return record;
}
