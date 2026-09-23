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

/** `murmur logs path` is intentionally unavailable on Windows (logs.windows-native-location-unavailable). */
export const skipPosixLogs = windows && 'logs path is intentionally unavailable on Windows; covered by the Windows test in setup-windows';

/** Assert a POSIX mode where it means something; on Windows record why it was not checked. */
export function assertMode(t, mode, expected, message) {
  if (posixModes) assert.equal(mode & 0o777, expected, message);
  else t.diagnostic(`${message ?? 'mode'} not checked: ${POSIX_MODE_REASON}`);
}
