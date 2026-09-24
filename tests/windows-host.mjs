// Named reasons for assertions that cannot hold on a Windows host. A test that depends on one of
// these is skipped with the reason instead of passing silently; a side assertion is guarded and
// reported through t.diagnostic.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const windows = process.platform === 'win32';

/** POSIX permission bits: Windows reports 0o666/0o777 whatever was requested; access is the DACL's job. */
export const posixModes = !windows;
export const POSIX_MODE_REASON = 'POSIX permission bits are not enforced on Windows; the DACL governs access';
export const skipPosixModes = windows && POSIX_MODE_REASON;

/** Windows creates symlinks only with SeCreateSymbolicLinkPrivilege (elevation or Developer Mode). */
export const symlinks = !windows || (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'murmur-symlink-probe-'));
  try {
    writeFileSync(path.join(dir, 'target'), '');
    symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch { return false; }
  finally { rmSync(dir, { recursive: true, force: true }); }
})();
export const skipWithoutSymlinks = !symlinks && 'symlinks need SeCreateSymbolicLinkPrivilege (elevation or Developer Mode) on this Windows host';

/** Tests that drive the launchd/systemd adapters against real files need POSIX absolute paths and modes. */
export const skipPosixServiceHost = windows && 'emulates a POSIX service manager on real files; needs a POSIX host';

/** The .sh wake drain needs a POSIX shell and the sqlite3 CLI; Windows uses the native wake-drain-claude.mjs. */
export const skipPosixShell = windows && 'POSIX shell script; on Windows the native scripts/wake-drain-claude.mjs is the wake drain (docs/wake-native.md)';

/**
 * Codex app-server wake speaks WebSocket over a Unix-domain socket only: ws+unix:// in
 * scripts/codex-app-server-wake.mjs and "--listen unix://PATH" in docs/wake-native.md. Node serves
 * local sockets on Windows as named pipes, and Murmur has no Windows transport for this wake.
 */
export const skipUnixSocketWake = windows && 'Codex app-server wake is WebSocket over a Unix-domain socket only (scripts/codex-app-server-wake.mjs ws+unix://, docs/wake-native.md); no Windows transport';

/** Windows reads native service logs rather than the POSIX configured folder. */
export const skipPosixLogs = windows && 'POSIX configured logs differ from Windows native service logs; covered in setup-windows';

/** Assert a POSIX mode where it means something; on Windows record why it was not checked. */
export function assertMode(t, mode, expected, message) {
  if (posixModes) assert.equal(mode & 0o777, expected, message);
  else t.diagnostic(`${message ?? 'mode'} not checked: ${POSIX_MODE_REASON}`);
}
