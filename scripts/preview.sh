#!/usr/bin/env bash
# The local preview: 1ctx from source on 127.0.0.1:1236, detached, with its
# pid, db, secrets and log under .preview/ (`clean` stops it and removes
# them, `reset` does that and provisions it again). ONECTX_DEV=1 turns on Bun's dev server: CSS hot-reloads in the
# browser, an edit under src/client/ reloads the page; --watch restarts the
# process on server-side TypeScript changes.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=${PREVIEW_PORT:-1236}
DIR=.preview
PID=$DIR/pid
LOG=$DIR/log
URL=http://127.0.0.1:$PORT
ENTRY=src/server/main.ts

# only a process running our entry from this checkout is ours to kill:
# a reused pid, another checkout, or a stranger on the port is left alone
HERE=$(pwd -P)
ours() {
  ps -o command= -p "$1" 2>/dev/null | grep -q -- "$ENTRY" || return 1
  [ "$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$HERE" ]
}
running() { [ -f "$PID" ] && ours "$(cat "$PID")"; }

stop() {
  if running; then
    kill "$(cat "$PID")"
    for _ in $(seq 1 50); do running || break; sleep 0.1; done
  fi
  # a preview from an older start that lost its pid file
  for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    ours "$pid" && kill "$pid" || true
  done
  rm -f "$PID"
}

keys() {
  # the secrets are readable by the owner alone
  mkdir -p "$DIR/secrets"
  chmod 700 "$DIR/secrets"
  if [ ! -f "$DIR/secrets/user-admin.key" ]; then
    # the bootstrap password for the preview's admin; read once, when the
    # users table is empty, and hashed into the db
    (umask 077 && printf 'admin-preview' >"$DIR/secrets/user-admin.key")
  fi
  chmod 600 "$DIR/secrets"/*.key
}

# applying needs the database to itself, so the preview is stopped first
# and left stopped when a refusal ends the run
provision() {
  [ -n "${1:-}" ] || { echo "usage: $0 provision <file|dir>" >&2; exit 1; }
  stop
  keys
  bun "$ENTRY" provision -f "$1" \
    --db "$DIR/1ctx.sqlite" --secrets "$DIR/secrets"
  start
}

# a fresh preview from a provision file: the db, the secrets and the log
# go, the given secrets directory is copied in before the first start so
# the admin comes from its user-admin.key, then the file is applied
reset() {
  [ -n "${1:-}" ] || { echo "usage: $0 reset <file|dir> [secrets-dir]" >&2; exit 1; }
  if [ -n "${2:-}" ] && [ ! -d "$2" ]; then
    echo "no secrets directory at $2" >&2
    exit 1
  fi
  stop
  rm -rf "$DIR"
  mkdir -p "$DIR/secrets"
  if [ -n "${2:-}" ]; then cp -R "$2"/. "$DIR/secrets/"; fi
  provision "$1"
}

start() {
  keys
  ONECTX_DEV=1 nohup bun --watch "$ENTRY" \
    --listen "127.0.0.1:$PORT" --db "$DIR/1ctx.sqlite" \
    --secrets "$DIR/secrets" >"$LOG" 2>&1 &
  echo $! >"$PID"
  for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "$URL/api/health"; then
      echo "preview up at $URL (pid $(cat "$PID"), log $LOG)"
      return 0
    fi
    running || break
    sleep 0.2
  done
  echo "preview did not answer at $URL; log tail:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

case "${1:-restart}" in
  start) running && { echo "preview already up at $URL (pid $(cat "$PID"))"; exit 0; }; start ;;
  stop) stop; echo "preview stopped" ;;
  clean) stop; rm -rf "$DIR"; echo "preview stopped, $DIR removed" ;;
  provision) provision "${2:-}" ;;
  reset) reset "${2:-}" "${3:-}" ;;
  restart) stop; start ;;
  status) if running; then echo "preview up at $URL (pid $(cat "$PID"))"; else echo "preview not running"; exit 1; fi ;;
  log) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|status|clean|provision <file>|reset <file> [secrets]|log [lines]" >&2; exit 1 ;;
esac
