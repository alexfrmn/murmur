import { mkdir, readdir, rmdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const paths = path.win32;
const inside = (base: string, dir: string) => {
  const relative = paths.relative(base, dir);
  return relative && !relative.startsWith('..') && !paths.isAbsolute(relative) ? relative : null;
};
const identity = (dir: string) => stat(dir).then(s => `${s.dev}:${s.ino}`, () => null);

/**
 * A process with MSIX package identity (e.g. an app installed from Microsoft Store) sees AppData
 * virtualized: writes to %LOCALAPPDATA%\X land in %LOCALAPPDATA%\Packages\<pkg>\LocalCache\Local\X,
 * while the LocalSystem service reads the real, empty %LOCALAPPDATA%\X. Detect it by filesystem
 * identity, not by name: inside the package the profile and its LocalCache twin are one directory,
 * outside it a leftover twin is a different one. A profile that does not exist yet is probed in its
 * nearest existing ancestor with a temporary directory that is removed again.
 */
export async function refuseVirtualizedAppData(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== 'win32' || !env.LOCALAPPDATA) return;
  const packages = paths.join(env.LOCALAPPDATA, 'Packages');
  if (inside(packages, dataDir) !== null) return;
  const bases = [[env.LOCALAPPDATA, 'Local'], [env.APPDATA, 'Roaming']] as const;
  const base = bases.find(([root]) => root && inside(root, dataDir) !== null);
  if (!base) return;
  // Climb to the nearest existing directory that is still inside the AppData root.
  let probe: string | null = null, target = dataDir;
  while (await identity(target) === null && inside(base[0]!, paths.dirname(target)) !== null) target = paths.dirname(target);
  if (await identity(target) === null) {
    target = paths.join(paths.dirname(target), `.murmur-appdata-probe-${randomUUID()}`);
    await mkdir(target); probe = target;
  }
  try {
    const own = await identity(target), relative = inside(base[0]!, target)!;
    const names = await readdir(packages).catch(() => [] as string[]);
    for (const name of names) {
      if (await identity(paths.join(packages, name, 'LocalCache', base[1], relative)) === own) throw new Error('profile.virtualized-appdata');
    }
  } finally { if (probe) await rmdir(probe).catch(() => {}); }
}
