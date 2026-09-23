import { constants } from 'node:fs';
import { mkdir, open, rmdir, lstat, unlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SQLiteDedupeOutboxStore } from '@murmurv2/core';
import { createKeyPair, createSigningKeyPair } from '@murmurv2/security';
import { loadConfig, validateConfig, validAgentId, type AgentConfig, type PeerConfig } from './config.js';
import { writeState } from './state.js';
import type { ServiceContext } from './types.js';

type PrivateFile = 'invite-file' | 'reply-file' | 'token-file';
async function privateText(file: string, role: PrivateFile): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error('onboarding.file-must-be-absolute');
  // Name the option and the reason, never the path or contents: this is what a new user acts on.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') throw new Error(`onboarding.${role}-not-found`);
    if (e.code === 'EPERM' || e.code === 'EACCES') throw new Error(`onboarding.${role}-access-denied`);
    throw e;
  });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384) throw new Error('onboarding.file-invalid');
    return (await handle.readFile('utf8')).trim();
  } finally { await handle.close(); }
}
/** Resolve existing ancestors without erasing symlink/.. filesystem semantics. */
async function canonicalPath(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonicalPath(parent), path.basename(file));
  }
}
async function validateOutput(c: ServiceContext, file: string) {
  if (!path.isAbsolute(file)) throw new Error('onboarding.output-must-be-absolute');
  let parent: string;
  try { parent = await realpath(path.dirname(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('onboarding.output-parent-required');
    throw error;
  }
  if (!(await stat(parent)).isDirectory()) throw new Error('onboarding.output-parent-required');
  // A nonexistent output parent must not become valid as a side effect of profile creation.
  // On case-insensitive APFS, differently spelled missing paths can name that same directory.
  const target = path.join(parent, path.basename(file)), profile = await canonicalPath(c.dataDir);
  const relative = path.relative(profile, target);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('onboarding.output-inside-profile');
  }
  const profileInfo = await stat(c.dataDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  // Existing path aliases are compared by filesystem identity, not by lowercasing names.
  if (profileInfo) for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    const info = await stat(ancestor);
    if (info.dev === profileInfo.dev && info.ino === profileInfo.ino) throw new Error('onboarding.output-inside-profile');
    if (path.dirname(ancestor) === ancestor) break;
  }
}
async function outputBlob(file: string, value: unknown, prefix: string, beforeWrite?: () => Promise<void>) {
  if (!path.isAbsolute(file)) throw new Error('onboarding.output-must-be-absolute');
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await beforeWrite?.();
    await handle.writeFile(prefix + Buffer.from(JSON.stringify(value)).toString('base64') + '\n'); await handle.sync();
  } catch (error) { await unlink(file).catch(() => {}); throw error; }
  finally { await handle.close(); }
}
async function locked<T>(c: ServiceContext, fn: () => Promise<T>) {
  await mkdir(c.dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(c.dataDir, '.setup-write.lock');
  await mkdir(lock, { mode: 0o700 });
  try { return await fn(); } finally { await rmdir(lock); }
}
async function existing(c: ServiceContext): Promise<AgentConfig | null> {
  try { return await loadConfig(c); } catch (e) { if (e instanceof Error && e.message === 'config.missing') return null; throw e; }
}
async function newConfig(agentId: string, url: string, token?: string): Promise<AgentConfig> {
  if (!validAgentId(agentId)) throw new Error('config.identity-invalid');
  return validateConfig({ agentId, subject: `msg.${agentId}`, natsUrl: url, ...(token ? { natsToken: token } : {}),
    keys: { encryption: await createKeyPair(), signing: await createSigningKeyPair() }, peers: {},
    wake: { enabled: true }, ackSecurity: { emitSigned: true, requireSigned: true } });
}
async function saveChanged(c: ServiceContext, previous: AgentConfig | null, next: AgentConfig) {
  validateConfig(next);
  if (previous && isDeepStrictEqual(previous, next)) return null;
  const backup = previous ? path.join(c.dataDir, `agent-config.backup-${randomUUID()}.json`) : null;
  if (backup) await writeState(c, backup, previous);
  await writeState(c, c.configPath, next);
  if (!previous) await writeState(c, path.join(c.dataDir, 'read-state.json'), { schema: 'murmur.read/1', agentId: next.agentId, rowid: 0 });
  return backup;
}
const publicPeer = (c: AgentConfig) => ({ agentId: c.agentId, subject: c.subject,
  encryption: { publicKey: c.keys.encryption.publicKey }, signing: { publicKey: c.keys.signing.publicKey } });
async function readBlob(file: string, prefix: string, type: 'invite' | 'reply') {
  const text = await privateText(file, `${type}-file`);
  if (!text.startsWith(prefix)) throw new Error('onboarding.invalid-blob');
  const encoded = text.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('onboarding.invalid-blob');
  let value;
  try { value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { throw new Error('onboarding.invalid-blob'); }
  if (!value || value.v !== 1 || value.type !== type || !validAgentId(value.agentId) || value.subject !== `msg.${value.agentId}`) throw new Error('onboarding.invalid-peer');
  for (const key of [value.encryption?.publicKey, value.signing?.publicKey]) {
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('onboarding.invalid-peer-key');
  }
  if (type === 'invite' && (typeof value.natsUrl !== 'string' || (value.natsToken !== undefined && typeof value.natsToken !== 'string'))) throw new Error('onboarding.invalid-broker');
  return value;
}
function addPeer(config: AgentConfig, peer: { agentId: string; subject: string; encryption: { publicKey: string }; signing: { publicKey: string } }): AgentConfig {
  if (peer.agentId === config.agentId) throw new Error('onboarding.self-peer');
  const previous = config.peers[peer.agentId];
  if (previous && (previous.subject !== peer.subject || previous.encryption.publicKey !== peer.encryption.publicKey || previous.signing.publicKey !== peer.signing.publicKey)) throw new Error('onboarding.peer-key-conflict');
  const next: PeerConfig = previous ?? { subject: peer.subject, encryption: { publicKey: peer.encryption.publicKey }, signing: { publicKey: peer.signing.publicKey } };
  return { ...config, peers: { ...config.peers, [peer.agentId]: next } };
}
export async function initialize(c: ServiceContext, options: { agentId: string; brokerUrl: string; tokenFile?: string }) {
  return locked(c, async () => {
    const previous = await existing(c);
    if (previous) {
      if (previous.agentId !== options.agentId || previous.natsUrl !== options.brokerUrl) throw new Error('onboarding.existing-profile-conflict');
      // Re-running init never rotates keys or replaces credentials.
      return { schema: 'murmur.init/1', agentId: previous.agentId, dataDir: c.dataDir, existing: true };
    }
    const token = options.tokenFile ? await privateText(options.tokenFile, 'token-file') : undefined;
    if (token?.includes('\n') || token?.includes('\r')) throw new Error('onboarding.token-file-invalid');
    const config = await newConfig(options.agentId, options.brokerUrl, token);
    await saveChanged(c, null, config);
    return { schema: 'murmur.init/1', agentId: config.agentId, dataDir: c.dataDir, existing: false };
  });
}
export async function invite(c: ServiceContext, outFile: string) {
  await validateOutput(c, outFile);
  const config = await loadConfig(c);
  await outputBlob(outFile, { v: 1, type: 'invite', ...publicPeer(config), natsUrl: config.natsUrl, ...(config.natsToken ? { natsToken: config.natsToken } : {}) }, 'MURMUR:');
  // The warning names what is actually inside. A person weighs "password" and "identity"
  // differently, and the same sentence for both teaches them to ignore it.
  const containsBrokerCredential = !!config.natsToken;
  return { schema: 'murmur.invite/1', file: outFile, containsBrokerCredential,
    instruction: containsBrokerCredential
      ? 'This file carries the broker address and its credential. Treat it like a password: send it only through a channel you would trust with one. Importing it does not prove pairing.'
      : 'This file carries your identity and the broker address. Send it through a channel you trust. Importing it does not prove pairing.' };
}
export async function join(c: ServiceContext, options: { agentId: string; inviteFile: string; replyOut: string }) {
  await validateOutput(c, options.replyOut);
  const incoming = await readBlob(options.inviteFile, 'MURMUR:', 'invite');
  return locked(c, async () => {
    const previous = await existing(c);
    if (previous && (previous.agentId !== options.agentId || previous.natsUrl !== incoming.natsUrl)) throw new Error('onboarding.existing-profile-conflict');
    const config = previous ?? await newConfig(options.agentId, incoming.natsUrl, incoming.natsToken);
    const next = addPeer(config, incoming);
    let backup: string | null = null;
    // Reserve the reply path before changing config: an existing output must not half-import a profile.
    await outputBlob(options.replyOut, { v: 1, type: 'reply', ...publicPeer(next) }, 'MURMUR-REPLY:', async () => {
      backup = await saveChanged(c, previous, next);
    });
    return { schema: 'murmur.join/1', agentId: next.agentId, peerId: incoming.agentId, paired: null, replyFile: options.replyOut, backup, restartRequired: true };
  });
}
async function clearPeerPoison(c: ServiceContext, peerId: string) {
  try {
    const info = await lstat(c.storePath);
    if (!info.isFile()) throw new Error('onboarding.store-invalid');
    const store = new SQLiteDedupeOutboxStore(c.storePath);
    try { return { cleared: await store.clearPoisonedFrom(peerId), reason: null }; }
    finally { store.close(); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { cleared: 0, reason: null };
    // Key import succeeded; an unreadable/locked store must not be reported as zero cleared.
    return { cleared: null, reason: 'onboarding.poison-reset-failed' };
  }
}
export async function importPeer(c: ServiceContext, replyFile: string) {
  const incoming = await readBlob(replyFile, 'MURMUR-REPLY:', 'reply');
  return locked(c, async () => {
    const previous = await loadConfig(c), next = addPeer(previous, incoming);
    const backup = await saveChanged(c, previous, next);
    return { schema: 'murmur.peer/1', peerId: incoming.agentId, paired: null, backup,
      poisonReset: await clearPeerPoison(c, incoming.agentId), restartRequired: true };
  });
}
