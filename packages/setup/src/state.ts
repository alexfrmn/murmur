import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ServiceContext } from "./types.js";
import { protectPrivateFile } from "./private-file.js";

/** Reuse the runtime's existing private-state writer; setup ships with that runtime. */
export async function writeState(c: ServiceContext, file: string, value: unknown): Promise<void> {
  if (path.dirname(file) !== c.dataDir) throw new Error("state.outside-data-dir");
  const helpers = await import(pathToFileURL(path.join(c.repoRoot, "scripts", "secure-state.mjs")).href);
  await helpers.writePrivateJson(file, value, { beforeWrite: protectPrivateFile });
}
