#!/usr/bin/env bash
# murmur-coldidle-watch.sh — standing cold-idle wake for JARVIS (claudeworker).
#
# Complements the Stop/PostToolUse/UserPromptSubmit hook wake-drain-claude.sh:
#   - Stop-hook  => wakes on turn-end (active session).
#   - this watcher => polls the daemon DB while the session is COLD-IDLE (no turns),
#     exits when a new inbound Murmur message arrives so the Claude Code harness
#     re-invokes the session (background-task completion = wake).
#
# Shares the SAME cursor (~/.murmur-wake-cursor) as the hook => a message wakes once.
# Re-arm after each fire (launch again in background).
set -uo pipefail

DB="${MURMUR_DB:-/opt/lifecoach/mur-mur-v2/.data/murmur.db}"
CURSOR="${MURMUR_WAKE_CURSOR:-$HOME/.murmur-wake-cursor}"
INTERVAL="${MURMUR_WATCH_INTERVAL:-20}"
LOCK="${MURMUR_WATCH_LOCK:-$HOME/.murmur-coldidle-watch.lock}"
LOCK_WAIT="${MURMUR_WATCH_LOCK_WAIT:-21600}"   # 6ч — дольше любой разумной сессии

[ -r "$DB" ] || { echo "watcher: DB not readable: $DB" >&2; exit 1; }

# ── single-flight: опрашивать БД должен РОВНО ОДИН watcher ──────────────────
# WHY: армится на КАЖДОМ jarvis-start, а сессий параллельно 6-11 → набиралось по
# несколько инстансов, и каждый долбил sqlite раз в 20с по одному и тому же курсору.
# Держатель lock работает; лишние НЕ выходят сразу (мгновенный exit = завершение
# background-задачи = ложный re-invoke сессии), а спят на flock в ядре: 0 CPU, 0
# запросов к БД. Когда держатель отстреливается по wake — очередной подхватывает
# без нового re-arm.
# NB: `exec 9>"$LOCK"` БЕЗ хвостового `2>/dev/null` — exec без команды правит дескрипторы
# ВСЕГО скрипта, и такой довесок глушит stderr навсегда (поймано при отладке 26.07:
# инстанс выходил молча, диагностика уходила в никуда).
exec 9>"$LOCK" || { echo "watcher: cannot open lock $LOCK" >&2; exit 1; }
if ! flock -n 9; then
  # Сознательно БЕЗ подсчёта «сколько уже в очереди». Пробовали два способа, оба врут:
  # `pgrep -f <имя скрипта>` ловит любую постороннюю команду, где имя есть в аргументах
  # (свои же bash-обёртки, ps|grep из соседней сессии); `fuser` считает не только PID'ы,
  # а fd ещё и наследуется через setsid. Фантомный счётчик глушил ЛЕГИТИМНЫЕ инстансы.
  # Ограничение и не нужно: ждущие спят на flock в ядре — 0 CPU, 0 запросов к БД,
  # ~3 МБ RSS, а LOCK_WAIT ставит потолок времени жизни.
  echo "watcher: активный инстанс есть — жду его смены (до ${LOCK_WAIT}с, БД не опрашиваю)" >&2
  if ! flock -w "$LOCK_WAIT" 9; then
    echo "watcher: не дождался lock за ${LOCK_WAIT}с — выхожу тихо" >&2
    exit 0
  fi
  echo "watcher: перехватил lock — заступаю на опрос"
fi

while true; do
  last="$(cat "$CURSOR" 2>/dev/null || printf '0\n')"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac

  max="$(sqlite3 "$DB" \
    "SELECT COALESCE(MAX(rowid), $last) FROM local_messages WHERE direction='inbound';" \
    2>/dev/null || echo "$last")"
  case "$max" in ''|*[!0-9]*) max="$last" ;; esac

  if [ "$max" -gt "$last" ]; then
    rows="$(sqlite3 "$DB" \
      "SELECT '  rowid='||rowid||' ['||sender||'] '||substr(replace(replace(text,char(10),' '),char(13),' '),1,400) \
       FROM local_messages \
       WHERE direction='inbound' AND rowid > $last \
       ORDER BY rowid;" 2>/dev/null || true)"
    # drain-to-tip: advance cursor so the message wakes exactly once
    tmp="${CURSOR}.$$"
    if printf '%s\n' "$max" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$CURSOR" 2>/dev/null || rm -f "$tmp"
    fi
    echo "MURMUR COLD-IDLE WAKE: $((max - last)) new inbound message(s) (rowid $((last + 1))..$max)"
    printf '%s\n' "$rows"
    echo "Re-arm the watcher after handling."
    exit 0
  fi

  sleep "$INTERVAL"
done
