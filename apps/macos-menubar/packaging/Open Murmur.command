#!/bin/bash
set -eu
umask 077
ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
CLI="$ROOT/runtime/packages/setup/bin/murmur.mjs"
APP="$ROOT/Murmur Spike.app"

fail() { printf '%s\n' "$1" >&2; exit 1; }
case "${1-}" in ''|--check) ;; *) fail 'Usage: Open Murmur.command [--check]' ;; esac
[ -f "$CLI" ] && [ -f "$ROOT/runtime/packages/setup/dist/src/cli.js" ] ||
  fail 'Murmur runtime is missing. Extract the complete release folder, including runtime/.'
[ -x "$ROOT/murmur" ] || fail 'The Murmur CLI launcher is missing from this release folder.'
[ -x "$APP/Contents/MacOS/MurmurMenuBar" ] || fail 'The Murmur app is missing from this release folder.'
if /usr/bin/pgrep -x MurmurMenuBar >/dev/null 2>&1; then
  fail 'Murmur is already open. Quit it from its menu before opening or checking this release.'
fi

# Resolve external Node once. The tray's restricted PATH must not change this choice.
NODE="${MURMUR_NODE-}"
if [ -z "$NODE" ]; then NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || fail 'Install Node.js 22.13.0 or newer, then open Murmur again. No compiler is required.'
unset NODE_OPTIONS NODE_PATH DATA_DIR MURMUR_STORE_PATH MURMUR_DATA_DIR MURMUR_SERVICE_NAME MURMUR_CLI
SAFE_ENV=(/usr/bin/env -i "HOME=${HOME-}" "USER=${USER-}" "LOGNAME=${LOGNAME-}"
  "TMPDIR=${TMPDIR-/tmp}" "LANG=${LANG-en_US.UTF-8}" "LC_ALL=${LC_ALL-}" "TZ=${TZ-}"
  'PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
if [ "${MURMUR_UPDATE_CHECK-}" = 0 ]; then SAFE_ENV+=('MURMUR_UPDATE_CHECK=0'); fi
NODE="$("${SAFE_ENV[@]}" "$NODE" -p 'process.execPath')"
case "$NODE" in /*) ;; *) fail 'Node did not return an absolute executable path.' ;; esac
case "$NODE" in *$'\n'*|*$'\r'*) fail 'The Node executable path contains a line break.' ;; esac
[ -x "$NODE" ] || fail 'The selected Node executable is unavailable.'
# Shared engine owns version and SQLite capability checks; do not duplicate them here.
"${SAFE_ENV[@]}" "$NODE" "$CLI" version --json
binding="$(/usr/bin/mktemp "$ROOT/.murmur-node.XXXXXX")"
trap 'if [ -n "${binding-}" ]; then /bin/rm -f -- "$binding"; fi' EXIT
printf '%s\n' "$NODE" > "$binding"
/bin/chmod 600 "$binding"
/bin/mv -f -- "$binding" "$ROOT/.murmur-node"
binding=''
if [ "${1-}" = --check ]; then
  printf 'Ready: %s\n' "$ROOT/murmur"
  exit 0
fi
# Bind only the CLI. Profile selection and all profile paths remain owned by UI/engine.
exec "${SAFE_ENV[@]}" /usr/bin/open --env "MURMUR_BIN=$ROOT/murmur" "$APP"
