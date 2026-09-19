import { constants } from 'node:fs';
import { mkdir, open, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createKeyPair, createSigningKeyPair } from '@murmurv2/security';
import { loadConfig, validateConfig, validAgentId, type AgentConfig, type PeerConfig } from './config.js';
import { writeState } from './state.js';
import type { ServiceContext } from './types.js';

async function privateText(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error('onboarding.file-must-be-absolute');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384) throw new Error('onboarding.file-invalid');
    return (await handle.readFile('utf8')).trim();
  } finally { await handle.close(); }
}
async function outputBlob(file: string, value: unknown, prefix: string) {
  if (!path.isAbsolute(file)) throw new Error('onboarding.output-must-be-absolute');
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(prefix + Buffer.from(JSON.stringify(value)).toString('base64') + '\n'); await handle.sync(); }
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
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return null;
  const backup = previous ? path.join(c.dataDir, `agent-config.backup-${randomUUID()}.json`) : null;
  if (backup) await writeState(c, backup, previous);
  await writeState(c, c.configPath, next);
  if (!previous) await writeState(c, path.join(c.dataDir, 'read-state.json'), { schema: 'murmur.read/1', agentId: next.agentId, rowid: 0 });
  return backup;
}
const publicPeer = (c: AgentConfig) => ({ agentId: c.agentId, subject: c.subject,
  encryption: { publicKey: c.keys.encryption.publicKey }, signing: { publicKey: c.keys.signing.publicKey } });
async function readBlob(file: string, prefix: string, type: 'invite' | 'reply') {
  const text = await privateText(file);
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
    const token = options.tokenFile ? await privateText(options.tokenFile) : undefined;
    if (token?.includes('\n') || token?.includes('\r')) throw new Error('onboarding.token-file-invalid');
    const config = await newConfig(options.agentId, options.brokerUrl, token);
    await saveChanged(c, null, config);
    return { schema: 'murmur.init/1', agentId: config.agentId, dataDir: c.dataDir, existing: false };
  });
}
export async function invite(c: ServiceContext, outFile: string) {
  const config = await loadConfig(c);
  await outputBlob(outFile, { v: 1, type: 'invite', ...publicPeer(config), natsUrl: config.natsUrl, ...(config.natsToken ? { natsToken: config.natsToken } : {}) }, 'MURMUR:');
  return { schema: 'murmur.invite/1', file: outFile, containsBrokerCredential: !!config.natsToken,
    instruction: 'Transfer this private invite file through a trusted channel; importing it does not prove pairing.' };
}
export async function join(c: ServiceContext, options: { agentId: string; inviteFile: string; replyOut: string }) {
  const incoming = await readBlob(options.inviteFile, 'MURMUR:', 'invite');
  return locked(c, async () => {
    const previous = await existing(c);
    if (previous && (previous.agentId !== options.agentId || previous.natsUrl !== incoming.natsUrl)) throw new Error('onboarding.existing-profile-conflict');
    const config = previous ?? await newConfig(options.agentId, incoming.natsUrl, incoming.natsToken);
    const next = addPeer(config, incoming), backup = await saveChanged(c, previous, next);
    await outputBlob(options.replyOut, { v: 1, type: 'reply', ...publicPeer(next) }, 'MURMUR-REPLY:');
    return { schema: 'murmur.join/1', agentId: next.agentId, peerId: incoming.agentId, paired: null, replyFile: options.replyOut, backup, restartRequired: true };
  });
}
export async function importPeer(c: ServiceContext, replyFile: string) {
  const incoming = await readBlob(replyFile, 'MURMUR-REPLY:', 'reply');
  return locked(c, async () => {
    const previous = await loadConfig(c), next = addPeer(previous, incoming);
    const backup = await saveChanged(c, previous, next);
    return { schema: 'murmur.peer/1', peerId: incoming.agentId, paired: null, backup, restartRequired: true };
  });
}
