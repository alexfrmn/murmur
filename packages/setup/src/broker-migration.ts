import { mkdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readJsonSnapshot, validateConfig, type AgentConfig } from './config.js';
import { readBrokerInputsSnapshot, type BrokerInputFiles } from './broker-input.js';
import { restoreExactBackup, writeExactBackup, writeState } from './state.js';
import type { PlatformAdapter, ServiceContext } from './types.js';

export interface BrokerMigrationOptions extends BrokerInputFiles { brokerUrl: string; apply?: boolean }
interface MigrationCandidate { before: AgentConfig; after: AgentConfig; configBytes: Buffer; inputProof: string }
async function candidate(c: ServiceContext, options: BrokerMigrationOptions): Promise<MigrationCandidate> {
  const snapshot = await readJsonSnapshot(c.configPath);
  const before = validateConfig(snapshot.value, { allowLegacyRemotePlaintext: true });
  const input = await readBrokerInputsSnapshot(options);
  const afterRaw = { ...snapshot.value, natsUrl: options.brokerUrl };
  delete afterRaw.natsToken; delete afterRaw.natsUser; delete afterRaw.natsPassword; delete afterRaw.natsTls;
  Object.assign(afterRaw, input.config);
  const after = validateConfig(afterRaw);
  return { before, after, configBytes: snapshot.bytes, inputProof: input.proof };
}

const authKind = (config: AgentConfig) => config.natsToken ? 'token'
  : config.natsUser || config.natsPassword ? 'user-password' : 'none';
const redactedEndpoint = (config: AgentConfig) => ({ scheme: new URL(config.natsUrl).protocol, auth: authKind(config) });

async function observedDaemonIsAbsent(c: ServiceContext, config: AgentConfig): Promise<void> {
  let observation: any;
  try { observation = (await readJsonSnapshot(path.join(c.dataDir, 'daemon-observation.json'))).value; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('migration.runtime-unverifiable');
  }
  if (!observation || observation.schema !== 'murmur.runtime/1' || observation.agentId !== config.agentId
    || !Number.isSafeInteger(observation.pid) || observation.pid < 1 || typeof observation.storePath !== 'string' || !path.isAbsolute(observation.storePath)) {
    throw new Error('migration.runtime-unverifiable');
  }
  try {
    const [observed, expected] = await Promise.all([realpath(observation.storePath), realpath(c.storePath)]);
    if (observed !== expected) throw new Error('migration.runtime-unverifiable');
  } catch (error) {
    if (error instanceof Error && error.message === 'migration.runtime-unverifiable') throw error;
    throw new Error('migration.runtime-unverifiable');
  }
  try { process.kill(observation.pid, 0); throw new Error('migration.profile-in-use'); }
  catch (error) {
    if (error instanceof Error && error.message === 'migration.profile-in-use') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('migration.runtime-unverifiable');
  }
}

async function assertProfileFree(c: ServiceContext, adapter: PlatformAdapter, config: AgentConfig): Promise<void> {
  await observedDaemonIsAbsent(c, config);
  if (!adapter.profileUsage) throw new Error('migration.profile-usage-unavailable');
  let usage;
  try { usage = await adapter.profileUsage(c); }
  catch { throw new Error('migration.profile-usage-unavailable'); }
  if (!usage || !['free','in-use','unknown'].includes(usage.state) || typeof usage.reason !== 'string') throw new Error('migration.profile-usage-unavailable');
  if (usage.state === 'in-use') throw new Error('migration.profile-in-use');
  if (usage.state !== 'free') throw new Error('migration.profile-usage-unavailable');
}

async function restoreAfterWriteFailure(c: ServiceContext, backup: string, original: Buffer): Promise<never> {
  try {
    await restoreExactBackup(c, backup, c.configPath, original);
    if (!(await readJsonSnapshot(c.configPath)).bytes.equals(original)) throw new Error('migration.restore-verification-failed');
    await unlink(backup).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  } catch { throw new Error('migration.config-write-uncertain'); }
  throw new Error('migration.config-write-failed');
}

export async function migrateBroker(c: ServiceContext, adapter: PlatformAdapter, options: BrokerMigrationOptions) {
  if (!options.brokerUrl) throw new Error('migration.broker-url-required');
  const preview = await candidate(c, options);
  const changed = !isDeepStrictEqual(preview.before, preview.after);
  if (!options.apply) return { schema:'murmur.broker-migration/1', applied:false, changed, restartRequired:changed, backup:null,
    from:redactedEndpoint(preview.before), to:redactedEndpoint(preview.after) };
  if (!changed) return { schema:'murmur.broker-migration/1', applied:false, changed:false, restartRequired:false, backup:null,
    from:redactedEndpoint(preview.before), to:redactedEndpoint(preview.after) };
  const lock=path.join(c.dataDir,'.setup-write.lock');await mkdir(lock,{mode:0o700});
  try {
    const service = await adapter.status(c);
    if (service.state !== 'stopped' || service.pid !== null) throw new Error('migration.service-must-be-stopped');
    await assertProfileFree(c, adapter, preview.before);
    const current = await candidate(c, options);
    if (!current.configBytes.equals(preview.configBytes)) throw new Error('migration.config-changed');
    if (current.inputProof !== preview.inputProof || !isDeepStrictEqual(current.after, preview.after)) throw new Error('migration.input-changed');
    // Snapshot evidence is repeated immediately before mutation. A native adapter must
    // independently report this profile free; a stopped service alone is insufficient.
    await assertProfileFree(c, adapter, current.before);
    const backup=path.join(c.dataDir,`agent-config.backup-${randomUUID()}.json`);
    await writeExactBackup(c,backup,current.configBytes);
    try { await writeState(c,c.configPath,current.after); }
    catch { return await restoreAfterWriteFailure(c, backup, current.configBytes); }
    return { schema:'murmur.broker-migration/1', applied:true, changed:true, restartRequired:true, backup,
      from:redactedEndpoint(current.before), to:redactedEndpoint(current.after) };
  } finally { await rmdir(lock); }
}
