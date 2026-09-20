import * as fs from "node:fs/promises";
import path from "node:path";
import type { ServiceContext } from "../types.js";

const maximumEntries = 10_000;

export interface VerifiedProfileRoot {
  root: string;
  /** Opaque tree identity used only to reject changes during a free snapshot. */
  proof: string;
}

export class ProfileUsageUnknown extends Error {
  constructor(public readonly reason: string) { super(reason); }
}

const unknown = (reason: string): never => { throw new ProfileUsageUnknown(reason); };

export function isWithinProfile(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Require an owner-only selected root, then inspect its tree without following
 * aliases. Platform probes must still cover every visible process because a
 * privileged foreign UID can traverse the root. Aliases, mount crossings,
 * unsupported entries, hardlinks, or concurrent changes make the snapshot incomplete.
 */
export async function verifiedProfileRoot(context: ServiceContext): Promise<VerifiedProfileRoot> {
  let root: string;
  try {
    const selected = await fs.lstat(context.dataDir);
    if (selected.isSymbolicLink() || !selected.isDirectory() || (selected.mode & 0o077) !== 0) {
      return unknown("profile-usage.profile-unverifiable");
    }
    const uid = process.getuid?.();
    if (uid === undefined || selected.uid !== uid) return unknown("profile-usage.profile-unverifiable");
    root = await fs.realpath(context.dataDir);
    if (root !== context.dataDir) return unknown("profile-usage.profile-unverifiable");
    const rootInfo = await fs.stat(root);
    if (selected.dev !== rootInfo.dev || selected.ino !== rootInfo.ino || rootInfo.uid !== uid || (rootInfo.mode & 0o077) !== 0) {
      return unknown("profile-usage.profile-unverifiable");
    }
    const directories: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
    const proof = [["", rootInfo.dev, rootInfo.ino, rootInfo.mode, rootInfo.uid, rootInfo.gid, rootInfo.nlink]];
    let seen = 0;
    while (directories.length) {
      const directory = directories.pop()!;
      const names: string[] = [];
      for await (const entry of await fs.opendir(directory.absolute)) {
        if (++seen > maximumEntries) return unknown("profile-usage.profile-unverifiable");
        names.push(entry.name);
      }
      names.sort();
      for (const name of names) {
        const file = path.join(directory.absolute, name);
        const relative = path.join(directory.relative, name);
        const info = await fs.lstat(file);
        if (info.isSymbolicLink() || info.dev !== rootInfo.dev) return unknown("profile-usage.profile-unverifiable");
        if (info.isFile() && info.nlink !== 1) return unknown("profile-usage.profile-hard-linked");
        proof.push([relative, info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink]);
        if (info.isDirectory()) directories.push({ absolute: file, relative });
        else if (!info.isFile()) return unknown("profile-usage.profile-unverifiable");
      }
    }
    return { root, proof: JSON.stringify(proof) };
  } catch (error) {
    if (error instanceof ProfileUsageUnknown) throw error;
    return unknown("profile-usage.profile-unverifiable");
  }
}

/** Classify one kernel/tool pathname after the profile tree passed verification. */
export async function classifyProfilePath(root: string, raw: string): Promise<"inside" | "outside" | "unknown"> {
  if (!path.isAbsolute(raw) || /[\0\r\n]/.test(raw)) return "unknown";
  const deleted = raw.endsWith(" (deleted)");
  const candidate = path.normalize(deleted ? raw.slice(0, -" (deleted)".length) : raw);
  if (deleted) return "unknown";
  try {
    const canonical = await fs.realpath(candidate);
    return isWithinProfile(root, canonical) ? "inside" : "outside";
  } catch { return "unknown"; }
}
