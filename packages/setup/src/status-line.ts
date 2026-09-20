import { statusVerdict } from './verdict.js';

const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const safeCode = (value: string) => /^[a-z][a-z0-9.-]{0,80}$/.test(value) ? value : 'status.invalid';

/**
 * Render one untrusted-data-free segment for prompts, tmux and Claude Code.
 * Message bodies, peer IDs and runtime errors are deliberately never copied.
 */
export function renderStatusLine(status: unknown, now = Date.now()): string {
  const verdict = statusVerdict(status, now);
  const unreadValue = status && typeof status === 'object'
    ? (status as { inbox?: { unread?: unknown } }).inbox?.unread
    : null;
  const unread = natural(unreadValue) && unreadValue > 0 ? `Murmur: ${unreadValue} unread` : '';
  if (verdict.level === 'green') return unread;
  const label = verdict.level === 'red' ? 'error' : verdict.level === 'yellow' ? 'warning' : 'unknown';
  const health = `Murmur: ${label} (${safeCode(verdict.code)})`;
  return unread ? `${unread} | ${health}` : health;
}
