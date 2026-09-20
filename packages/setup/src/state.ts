import path from "node:path";
import { pathToFileURL } from "node:url";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ServiceContext } from "./types.js";

/** Reuse the runtime's existing private-state writer; setup ships with that runtime. */
export async function writeState(c: ServiceContext, file: string, value: unknown): Promise<void> {
  if (path.dirname(file) !== c.dataDir) throw new Error("state.outside-data-dir");
  const helpers = await import(pathToFileURL(path.join(c.repoRoot, "scripts", "secure-state.mjs")).href);
  await helpers.writePrivateJson(file, value);
}

async function syncDirectory(dir: string) {
  if (process.platform === "win32") return;
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Create a byte-exact, private, non-overwriting recovery file beside the profile. */
export async function writeExactBackup(c: ServiceContext, file: string, bytes: Buffer): Promise<void> {
  if (path.dirname(file) !== c.dataDir || bytes.length > 4 * 1024 * 1024) throw new Error("state.backup-invalid");
  let handle;
  let created = false;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await syncDirectory(c.dataDir);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(file).catch(() => {});
    throw error;
  }
}

/** Restore exact reviewed bytes atomically while retaining the backup until verification succeeds. */
export async function restoreExactBackup(c: ServiceContext, backup: string, target: string, bytes: Buffer): Promise<void> {
  if (path.dirname(backup) !== c.dataDir || target !== c.configPath) throw new Error("state.restore-invalid");
  const temp = path.join(c.dataDir, `.agent-config.restore-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temp, target); await syncDirectory(c.dataDir);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temp).catch(() => {});
    throw error;
  }
}
