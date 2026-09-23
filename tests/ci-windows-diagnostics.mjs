// CI-only evidence for Windows runner differences (JARVIS 040). Prints through t.diagnostic and
// never changes a test's outcome. Remove with the diagnostics PR.
import { execFileSync } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const system32 = tool => path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', tool);
const run = (file, args) => { try { return execFileSync(file, args, { encoding: 'utf8' }).trim(); } catch (e) { return `failed: ${e.code ?? e.message}`; } };
const say = (t, label, value) => t.diagnostic(`[ci-diag] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

export async function describeProcess(t) {
  if (process.platform !== 'win32') return;
  say(t, 'node', process.version);
  const groups = run(system32('whoami.exe'), ['/groups', '/fo', 'csv', '/nh']);
  say(t, 'integrity', (groups.match(/S-1-16-\d+/g) ?? []).join(','));
  say(t, 'admins group', /S-1-5-32-544"[^\n]*(Enabled group|Группа включена)/.test(groups) ? 'enabled' : groups.includes('S-1-5-32-544') ? 'present-not-enabled' : 'absent');
  say(t, 'privileges', run(system32('whoami.exe'), ['/priv', '/fo', 'csv', '/nh']).split(/\r?\n/).filter(l => /Backup|Restore|TakeOwnership/.test(l)).join(' | '));
  say(t, 'LOCALAPPDATA/APPDATA', { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA });
}

export async function describeIdentity(t, label, target) {
  if (process.platform !== 'win32') return;
  try {
    const s = await stat(target, { bigint: true });
    say(t, `${label} identity`, { dev: String(s.dev), ino: String(s.ino), realpath: await realpath(target) });
  } catch (e) { say(t, `${label} identity`, `stat failed: ${e.code}`); }
}

export async function describeFileAccess(t, file) {
  if (process.platform !== 'win32') return;
  say(t, 'icacls', run(system32('icacls.exe'), [file]).replace(/\s+/g, ' '));
  try { const h = await open(file, 'r'); await h.close(); say(t, 'direct open before join', 'SUCCEEDED'); } catch (e) { say(t, 'direct open before join', `failed ${e.code}`); }
}
