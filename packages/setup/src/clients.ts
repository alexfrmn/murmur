import * as TOML from '@iarna/toml';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ClientDetection, PlatformAdapter, ServiceContext } from './types.js';
import { loadConfig } from './config.js';
import { sameClientFileIdentity } from './file-identity.js';
import { protectPrivateFile } from './private-file.js';
export { sameClientFileIdentity } from './file-identity.js';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

async function selectedClient(c: ServiceContext, adapter: PlatformAdapter, clientId: string) {
  const client = (await adapter.detectClients(c)).find(item => item.id === clientId);
  if (!client || !client.installed) throw new Error('client.not-detected');
  if (!client.configPath || !path.isAbsolute(client.configPath)) throw new Error('client.config-path-unverified');
  return { ...client, configPath: client.configPath };
}
async function readClientFile(file: string) {
  let handle;
  try {
    // O_NOFOLLOW is unavailable on Windows. Inspect the link itself there too,
    // including dangling links, and bind the opened handle to the checked file.
    const before = await lstat(file, { bigint: true });
    if (!before.isFile()) throw new Error('client.config-file-invalid');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat({ bigint: true });
    const after = await lstat(file, { bigint: true });
    if (!info.isFile() || !after.isFile() || !sameClientFileIdentity(before, info)
      || !sameClientFileIdentity(after, info) || !sameClientFileIdentity(before, after) || info.size > 4n * 1024n * 1024n
      || (process.getuid && info.uid !== BigInt(process.getuid()))) throw new Error('client.config-file-invalid');
    return { text: await handle.readFile('utf8'), existed: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', existed: false };
    throw e;
  } finally { await handle?.close(); }
}
function clientDocument(client: ClientDetection, text: string) {
  const parse = (value: string): Record<string, any> => {
    try {
      const result = value.trim() ? client.format === 'json' ? JSON.parse(value) : TOML.parse(value) : {};
      if (!object(result)) throw new Error();
      return result;
    } catch { throw new Error('client.config-parse-failed'); }
  };
  const original = parse(text), key = client.format === 'json' ? 'mcpServers' : 'mcp_servers';
  if (original[key] !== undefined && !object(original[key])) throw new Error('client.mcp-table-invalid');
  return { original, key, parse };
}
function desiredEntry(c: ServiceContext) {
  return { command: c.nodePath, args: [path.join(c.repoRoot, 'packages', 'mcp-server', 'dist', 'src', 'index.js')],
    env: { DATA_DIR: c.dataDir, MURMUR_STORE_PATH: c.storePath } };
}
async function planFor(c: ServiceContext, client: ClientDetection & { configPath: string }, current: Awaited<ReturnType<typeof readClientFile>>) {
  const config = await loadConfig(c), { original, key } = clientDocument(client, current.text);
  const entry = desiredEntry(c), previous = original[key]?.murmur;
  const action = isDeepStrictEqual(previous, entry) ? 'unchanged' : previous === undefined ? 'add' : 'replace';
  // Bind confirmation to the target, exact bytes and selected identity/runtime.
  // No existing commands, environment values, auth or config contents leave the engine.
  const planId = createHash('sha256').update(JSON.stringify([client.id, client.configPath, current,
    config.agentId, config.keys.signing.publicKey, config.keys.encryption.publicKey, entry])).digest('hex');
  return { schema: 'murmur.client-plan/1', client: client.id, configPath: client.configPath,
    agentId: config.agentId, dataDir: c.dataDir, action, planId, configExisted: current.existed, restartRequired: true };
}

/** Read-only preview: even a missing parent directory is not created. */
export async function previewClientConfiguration(c: ServiceContext, adapter: PlatformAdapter, clientId: string) {
  const client = await selectedClient(c, adapter, clientId);
  return planFor(c, client, await readClientFile(client.configPath));
}

/** Patch only the selected Murmur entry; never execute a client or touch its auth. */
export async function configureClient(c: ServiceContext, adapter: PlatformAdapter, clientId: string, replace = false, expectedPlan?: string) {
  const client = await selectedClient(c, adapter, clientId), file = client.configPath;
  if (expectedPlan !== undefined && !/^[a-f0-9]{64}$/.test(expectedPlan)) throw new Error('client.plan-invalid');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.murmur-lock`;
  await mkdir(lock, { mode: 0o700 });
  try {
    const current = await readClientFile(file), { text, existed } = current;
    const plan = expectedPlan === undefined ? undefined : await planFor(c, client, current);
    if (plan && plan.planId !== expectedPlan) throw new Error('client.plan-stale');
    const { original, key, parse } = clientDocument(client, text), entry = desiredEntry(c);
    const confirmed = plan ? { planId: plan.planId, agentId: plan.agentId, dataDir: plan.dataDir } : {};
    const previous = original[key]?.murmur;
    if (isDeepStrictEqual(previous, entry)) return { schema: 'murmur.client/1', client: clientId, configPath: file, changed: false, backup: null, restartRequired: true, ...confirmed };
    if (previous !== undefined && !replace) throw new Error('client.murmur-entry-conflict');
    const next = { ...original, [key]: { ...original[key], murmur: entry } };
    const serialized = client.format === 'json' ? JSON.stringify(next, null, 2) + '\n' : TOML.stringify(next);
    if (!isDeepStrictEqual(parse(serialized), next)) throw new Error('client.config-roundtrip-failed');
    const backup = existed ? `${file}.murmur-backup-${randomUUID()}` : null;
    if (backup) {
      const out = await open(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await protectPrivateFile(backup, out); await out.writeFile(text); await out.sync(); } finally { await out.close(); }
    }
    const temporary = `${file}.murmur-${randomUUID()}.tmp`;
    try {
      const out = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await protectPrivateFile(temporary, out); await out.writeFile(serialized); await out.sync(); } finally { await out.close(); }
      // A client can save its config while the confirmation window is open or
      // while we prepare the backup. Refuse a changed target instead of losing it.
      if (!isDeepStrictEqual(await readClientFile(file), current)) throw new Error('client.plan-stale');
      if (plan && (await planFor(c, client, current)).planId !== plan.planId) throw new Error('client.plan-stale');
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
    return { schema: 'murmur.client/1', client: clientId, configPath: file, changed: true, backup, ...confirmed,
      restartRequired: true, instruction: 'Reload the selected client to activate the Murmur MCP entry.' };
  } finally { await rmdir(lock); }
}
