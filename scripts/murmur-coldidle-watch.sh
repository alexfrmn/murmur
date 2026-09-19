#!/usr/bin/env bash
# murmur-coldidle-watch.sh — standing cold-idle wake for JARVIS (claudeworker).
#
# Complements the Stop/PostToolUse/UserPromptSubmit hook wake-drain-claude.sh:
#   - Stop-hook  => wakes on turn-end (active session).
#   - this watcher => polls the daemon DB while the session is COLD-IDLE (no turns),
#     exits when a new inbound Murmur message arrives so the Claude Code harness
#     re-invokes the session (background-task completion = wake).
#
# Cursor is shared with the Stop-hook wake-drain-claude.sh => a message wakes once
# PER SESSION: both default to a cursor keyed by CLAUDE_CODE_SESSION_ID (see below).
# Re-arm after each fire (launch again in background).
set -uo pipefail

DB="${MURMUR_DB:-.data/murmur.db}"
INTERVAL="${MURMUR_WATCH_INTERVAL:-20}"
LOCK_WAIT="${MURMUR_WATCH_LOCK_WAIT:-21600}"   # 6ч — дольше любой разумной сессии

# ── ключ сессии: свой пост у каждой сессии ───────────────────────────────
# WHY (замер 26.08.2026): общий lock + общий курсор давали ОДИН живой watcher
# на весь хост. При семи параллельных сессиях входящее будило держателя поста —
# случайную сессию, а не ту, где лежит контекст переписки. Остальные спали на flock
# и не просыпались никогда: за 23-26.08 из 24 сессий watcher реально сторожил 13,
# а на посту в каждый момент стояла ровно одна. Теперь каждая сессия сторожит СЕБЯ.
# Цена — N запросов `SELECT MAX(rowid)` раз в 20с вместо одного; для sqlite это ничто.
# Явные MURMUR_WATCH_LOCK / MURMUR_WAKE_CURSOR по-прежнему перекрывают дефолт.
SESSION_KEY="${MURMUR_WAKE_SESSION_KEY:-${CLAUDE_CODE_SESSION_ID:-}}"
SESSION_KEY="${SESSION_KEY:0:8}"
if [ -n "$SESSION_KEY" ]; then
  CURSOR="${MURMUR_WAKE_CURSOR:-$HOME/.murmur-wake-cursor-$SESSION_KEY}"
  LOCK="${MURMUR_WATCH_LOCK:-$HOME/.murmur-coldidle-watch-$SESSION_KEY.lock}"
else
  # Не в сессии Claude Code (ручной запуск, cron, чужой харнесс) — легаси-пути.
  CURSOR="${MURMUR_WAKE_CURSOR:-$HOME/.murmur-wake-cursor}"
  LOCK="${MURMUR_WATCH_LOCK:-$HOME/.murmur-coldidle-watch.lock}"
fi

[ -r "$DB" ] || { echo "watcher: DB not readable: $DB" >&2; exit 1; }

# ── seed-to-tip на первом запуске ────────────────────────────────────────
# БЕЗ ЭТОГО per-session курсор сломал бы всё: файла нет → last=0 → первый же цикл
# видит ВСЮ историю входящих как «новое» и мгновенно будит сессию тысячами старых
# сообщений. Новая сессия сторожит С МОМЕНТА СВОЕГО СТАРТА.
if [ ! -f "$CURSOR" ]; then
  seed="$(sqlite3 "$DB" \
    "SELECT COALESCE(MAX(rowid), 0) FROM local_messages WHERE direction='inbound';" \
    2>/dev/null || echo 0)"
  case "$seed" in ''|*[!0-9]*) seed=0 ;; esac
  seed_tmp="${CURSOR}.$$"
  if printf '%s\n' "$seed" > "$seed_tmp" 2>/dev/null; then
    mv "$seed_tmp" "$CURSOR" 2>/dev/null || rm -f "$seed_tmp"
  fi
  echo "watcher: курсор засеян на rowid=$seed ($CURSOR)"
fi

# ── single-flight В ПРЕДЕЛАХ СЕССИИ: один watcher на один lock ───────────
# WHY: армится на КАЖДОМ jarvis-start, а внутри одной сессии скилл могут позвать
# повторно (ре-арм после срабатывания, /clear, ручной повтор) → дубли по одному
# и тому же курсору. С 26.08 lock per-session, поэтому ЧУЖИЕ сессии друг друга
# больше не блокируют — очередь на flock здесь только из своих.
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
    # Счёт БЕРЁТСЯ ИЗ ВЫБОРКИ, а не из разницы rowid: $max ищется только по
    # direction='inbound', но диапазон last+1..max содержит и наши исходящие —
    # печатать разницу значило завышать. 03.08: отрапортовал «3 new», реально 1.
    # grep -c сам печатает 0 при отсутствии совпадений; `|| echo 0` тут ЗАПРЕЩЁН
    # (даст "0\n0" — та же грабля, что с pgrep -c).
    cnt="$(printf '%s' "$rows" | grep -c '^  rowid=' || true)"
    echo "MURMUR COLD-IDLE WAKE: ${cnt} new inbound message(s) (последний inbound rowid=$max)"
    printf '%s\n' "$rows"
    echo "Re-arm the watcher after handling."
    exit 0
  fi

  sleep "$INTERVAL"
done
