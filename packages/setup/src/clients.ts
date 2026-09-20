import * as TOML from '@iarna/toml';
import { constants } from 'node:fs';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlatformAdapter, ServiceContext } from './types.js';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Patch only the selected Murmur entry; never execute a client or touch its auth. */
export async function configureClient(c: ServiceContext, adapter: PlatformAdapter, clientId: string, replace = false) {
  const client = (await adapter.detectClients(c)).find(item => item.id === clientId);
  if (!client || !client.installed) throw new Error('client.not-detected');
  const file = client.configPath;
  if (!file || !path.isAbsolute(file)) throw new Error('client.config-path-unverified');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.murmur-lock`;
  await mkdir(lock, { mode: 0o700 });
  let handle;
  try {
    let text = '', existed = false;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new Error('client.config-file-invalid');
      text = await handle.readFile('utf8'); existed = true;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    finally { await handle?.close(); handle = undefined; }
    const parse = (value: string): Record<string, any> => {
      try {
        const result = value.trim() ? client.format === 'json' ? JSON.parse(value) : TOML.parse(value) : {};
        if (!object(result)) throw new Error();
        return result;
      } catch { throw new Error('client.config-parse-failed'); }
    };
    const original = parse(text), key = client.format === 'json' ? 'mcpServers' : 'mcp_servers';
    if (original[key] !== undefined && !object(original[key])) throw new Error('client.mcp-table-invalid');
    const entry = { command: c.nodePath, args: [path.join(c.repoRoot, 'packages', 'mcp-server', 'dist', 'src', 'index.js')],
      env: { DATA_DIR: c.dataDir, MURMUR_STORE_PATH: c.storePath } };
    const previous = original[key]?.murmur;
    if (isDeepStrictEqual(previous, entry)) return { schema: 'murmur.client/1', client: clientId, configPath: file, changed: false, backup: null };
    if (previous !== undefined && !replace) throw new Error('client.murmur-entry-conflict');
    const next = { ...original, [key]: { ...original[key], murmur: entry } };
    const serialized = client.format === 'json' ? JSON.stringify(next, null, 2) + '\n' : TOML.stringify(next);
    if (!isDeepStrictEqual(parse(serialized), next)) throw new Error('client.config-roundtrip-failed');
    const backup = existed ? `${file}.murmur-backup-${randomUUID()}` : null;
    if (backup) {
      const out = await open(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await out.writeFile(text); await out.sync(); } finally { await out.close(); }
    }
    const temporary = `${file}.murmur-${randomUUID()}.tmp`;
    try {
      const out = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await out.writeFile(serialized); await out.sync(); } finally { await out.close(); }
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
    return { schema: 'murmur.client/1', client: clientId, configPath: file, changed: true, backup,
      restartRequired: true, instruction: 'Reload the selected client to activate the Murmur MCP entry.' };
  } finally { await rmdir(lock); }
}
