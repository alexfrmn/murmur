import type { BigIntStats } from 'node:fs';

/** Windows/libuv may omit the path's volume serial; a full inode must still match. */
export function sameClientFileIdentity(a: Pick<BigIntStats, 'dev' | 'ino'>, b: Pick<BigIntStats, 'dev' | 'ino'>, platform: NodeJS.Platform = process.platform) {
  if (a.ino !== b.ino) return false;
  if (platform !== 'win32') return a.dev === b.dev;
  // Node 22.13/libuv 1.49.2 can report path dev=0 with a nonzero handle dev.
  // When both are available, compare the Windows volume serial's low 32 bits:
  // https://github.com/libuv/libuv/commit/82cdfb75ff9bbd0dc65820ca418b7c5d412ff4d7
  return a.dev === 0n || b.dev === 0n || BigInt.asUintN(32, a.dev) === BigInt.asUintN(32, b.dev);
}
