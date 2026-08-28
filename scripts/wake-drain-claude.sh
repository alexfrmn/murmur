#!/usr/bin/env bash
# wake-drain-claude.sh - native tmux-free / OpenClaw-free wake for Claude Code agents.
#
# Registered as a Claude Code hook (Stop / PostToolUse / UserPromptSubmit) with
# `asyncRewake: true`. On each invocation it drains NEW inbound Murmur messages
# from the daemon's SQLite store; if any exist it prints them to STDERR and exits 2,
# so Claude Code wraps the output in a <system-reminder> and wakes the idle session.
#
# No tmux send-keys, no OpenClaw bridge, no polling daemon: native Claude Code wake.
# Dedup is cursor-based (last drained rowid), so a message wakes exactly once.
#
# Env:
#   MURMUR_DB               path to the agent daemon DB (default: jarvis store)
#   MURMUR_WAKE_CURSOR      file holding the last-drained rowid (per session/agent)
#   MURMUR_WAKE_SESSION_KEY overrides the session key used to build the default cursor
set -uo pipefail

DB="${MURMUR_DB:-.data/murmur.db}"

# ── ключ сессии: свой курсор у каждой сессии ─────────────────────────────
# WHY (26.08.2026): общий курсор на всех означает, что первая же сессия, дошедшая
# до Stop-хука, продвигает его до тика — и остальные не видят сообщения вообще.
# Пробуждение получал случайный, а не тот, кому сообщение адресовано. Тот же дефект
# чинится в murmur-coldidle-watch.sh; ключ у них ОДИН, поэтому хук и watcher одной
# сессии по-прежнему делят курсор и будят её ровно один раз.
SESSION_KEY="${MURMUR_WAKE_SESSION_KEY:-${CLAUDE_CODE_SESSION_ID:-}}"
SESSION_KEY="${SESSION_KEY:0:8}"
if [ -n "$SESSION_KEY" ]; then
  CURSOR="${MURMUR_WAKE_CURSOR:-$HOME/.murmur-wake-cursor-$SESSION_KEY}"
else
  CURSOR="${MURMUR_WAKE_CURSOR:-$HOME/.murmur-wake-cursor}"
fi

[ -r "$DB" ] || exit 0

# ── seed-to-tip: первый запуск в новой сессии НЕ вываливает всю историю ──
if [ ! -f "$CURSOR" ]; then
  seed="$(sqlite3 "$DB" \
    "SELECT COALESCE(MAX(rowid), 0) FROM local_messages WHERE direction='inbound';" \
    2>/dev/null || echo 0)"
  case "$seed" in ''|*[!0-9]*) seed=0 ;; esac
  mkdir -p "$(dirname "$CURSOR")" 2>/dev/null || true
  seed_tmp="${CURSOR}.$$"
  if printf '%s\n' "$seed" > "$seed_tmp" 2>/dev/null; then
    mv "$seed_tmp" "$CURSOR" 2>/dev/null || rm -f "$seed_tmp"
  fi
  exit 0
fi

last="$(cat "$CURSOR" 2>/dev/null || printf '0\n')"
case "$last" in ''|*[!0-9]*) last=0 ;; esac

# New inbound (from any peer) since the last drained rowid.
rows="$(sqlite3 "$DB" \
  "SELECT '  rowid='||rowid||' ['||sender||'] '||substr(replace(replace(text,char(10),' '),char(13),' '),1,360) \
   FROM local_messages \
   WHERE direction='inbound' AND rowid > $last \
   ORDER BY rowid;" 2>/dev/null || true)"

[ -z "$rows" ] && exit 0

# Advance cursor to the current max inbound rowid (drain-to-tip, no double-wake).
maxid="$(sqlite3 "$DB" \
  "SELECT COALESCE(MAX(rowid), $last) FROM local_messages WHERE direction='inbound';" \
  2>/dev/null || echo "$last")"
case "$maxid" in ''|*[!0-9]*) maxid="$last" ;; esac
cursor_dir="$(dirname "$CURSOR")"
mkdir -p "$cursor_dir" 2>/dev/null || true
tmp_cursor="${CURSOR}.$$"
if printf '%s\n' "$maxid" > "$tmp_cursor" 2>/dev/null; then
  mv "$tmp_cursor" "$CURSOR" 2>/dev/null || rm -f "$tmp_cursor"
else
  rm -f "$tmp_cursor"
fi

count="$(printf '%s\n' "$rows" | grep -c '^')"

# stderr + exit 2 => Claude Code injects a <system-reminder> and wakes the session.
{
  printf 'Murmur wake: %s new inbound message(s):\n' "$count"
  printf '%s\n' "$rows"
  printf 'Reply via murmur_send or act on them.\n'
} >&2
exit 2
