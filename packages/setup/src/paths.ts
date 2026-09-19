import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ServiceContext } from "./types.js";

export function resolveContext(options: { dataDir?: string; repoRoot?: string; nodePath?: string; serviceName?: string;
  platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}): ServiceContext {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const paths = platform === "win32" ? path.win32 : path.posix;
  const defaultDir = platform === "darwin" ? paths.join(home, "Library", "Application Support", "Murmur")
    : platform === "win32" ? paths.join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "Murmur")
    : paths.join(env.XDG_STATE_HOME || paths.join(home, ".local", "state"), "murmur");
  const dataDir = paths.normalize(options.dataDir ?? env.MURMUR_DATA_DIR ?? env.DATA_DIR ?? defaultDir);
  if (!paths.isAbsolute(dataDir)) throw new Error("config.data-dir-must-be-absolute");
  const repoRoot = paths.normalize(options.repoRoot ?? fileURLToPath(new URL("../../../../", import.meta.url))).replace(/[\\/]$/, "");
  const nodePath = paths.normalize(options.nodePath ?? process.execPath);
  if (!paths.isAbsolute(repoRoot) || !paths.isAbsolute(nodePath)) throw new Error("config.runtime-path-must-be-absolute");
  const serviceName = options.serviceName ?? `murmur-${createHash("sha256").update(dataDir).digest("hex").slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(serviceName)) throw new Error("config.invalid-service-name");
  return { dataDir, repoRoot, nodePath, serviceName, configPath: paths.join(dataDir, "agent-config.json"),
    storePath: paths.join(dataDir, "murmur.db"), logDir: paths.join(dataDir, "logs") };
}
