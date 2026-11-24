#!/usr/bin/env bash
# The local preview: 1ctx from source on 127.0.0.1:1236, detached, with its
# pid, db, secrets and log under .preview/ (`clean` stops it and removes
# them, `reset` does that and provisions it again). ONECTX_DEV=1 turns on Bun's dev server: CSS hot-reloads in the
# browser, an edit under src/client/ reloads the page; --watch restarts the
# process on server-side TypeScript changes.
#
# PREVIEW_SHELL=sandbox also runs an OpenShell gateway from
# .preview/openshell/ on 127.0.0.1:$PREVIEW_GATEWAY_PORT (17671) and turns
# the sandbox shell on (scripts/openshell.sh, docs/deploy.md). `stop`
# stops it too; `clean` and `reset` delete the preview's sandboxes
# through it before its directory goes, with or without the variable.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=${PREVIEW_PORT:-1236}
DIR=.preview
PID=$DIR/pid
LOG=$DIR/log
URL=http://127.0.0.1:$PORT
ENTRY=src/server/main.ts
GW=$DIR/openshell
GW_PORT=${PREVIEW_GATEWAY_PORT:-17671}
GW_PID=$GW/pid

# only a process running our entry from this checkout is ours to kill:
# a reused pid, another checkout, or a stranger on the port is left alone
HERE=$(pwd -P)
ours() {
  ps -o command= -p "$1" 2>/dev/null | grep -q -- "$ENTRY" || return 1
  [ "$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$HERE" ]
}
running() { [ -f "$PID" ] && ours "$(cat "$PID")"; }
# the port's only listener is the given pid, so a stranger answering
# health is never taken for ours nor sent the admin key
listens() {
  [ "$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" = "$1" ]
}

# the gateway is ours when its pid runs our binary from this checkout
gw_running() {
  [ -f "$GW_PID" ] &&
    ps -o command= -p "$(cat "$GW_PID")" 2>/dev/null |
    grep -q -- "$HERE/$GW/bin/openshell-gateway"
}

# the pid file goes only with the process: a clean that went on under a
# live gateway would remove its certificates and state
gw_stop() {
  if gw_running; then
    kill "$(cat "$GW_PID")"
    for _ in $(seq 1 100); do gw_running || break; sleep 0.1; done
    if gw_running; then
      echo "the gateway (pid $(cat "$GW_PID")) did not stop within 10 s; stop it, then run this again" >&2
      exit 1
    fi
  fi
  rm -f "$GW_PID"
}

gw_start() {
  scripts/openshell.sh ports "$HERE/$GW"
  scripts/openshell.sh rotate "$HERE/$GW"
  nohup scripts/openshell.sh run "$HERE/$GW" >"$GW/gateway.log" 2>&1 &
  echo $! >"$GW_PID"
  scripts/openshell.sh wait "$HERE/$GW" "$(cat "$GW_PID")"
}

# every sandbox, then provider, labelled with this instance id deleted
# through the gateway as it is configured now, started for it when down
gw_sweep() {
  local port
  port=$(sed -n 's/^PORT=//p' "$GW/gateway.env")
  gw_running || gw_start
  bun scripts/preview-sandbox.ts sweep "$GW/tls" "https://127.0.0.1:$port" "$1"
}

# after the server is up, since the instance id that labels the
# gateway's sandboxes is made at the server's first read of its row
sandbox() {
  local id old changed image
  scripts/openshell.sh docker
  id=$(bun scripts/preview-sandbox.ts id "$URL" "$DIR/secrets")
  # a new database under a kept gateway: the old instance's sandboxes go
  # first, while the gateway still carries their label
  old=$(cat "$GW/instance" 2>/dev/null || true)
  if [ -n "$old" ] && [ "$old" != "$id" ] && [ -f "$GW/gateway.env" ]; then
    gw_sweep "$old"
  fi
  changed=$(scripts/openshell.sh install "$HERE/$GW" "$GW_PORT" "1ctx-$id")
  printf '%s\n' "$id" >"$GW/instance"
  if [ -n "$changed" ] || ! gw_running; then
    gw_stop
    gw_start
  fi
  scripts/openshell.sh bundle "$HERE/$GW" "$DIR/secrets"
  # the saved variant's dev image, built when missing: the gateway uses a
  # local image before it pulls
  image=$(bun scripts/preview-sandbox.ts image "$URL" "$DIR/secrets")
  docker image inspect "$image" >/dev/null 2>&1 ||
    VARIANT=${image##*:dev-} scripts/sandbox-image.sh
  bun scripts/preview-sandbox.ts configure "$URL" "$DIR/secrets" \
    "https://127.0.0.1:$GW_PORT"
  echo "gateway up at https://127.0.0.1:$GW_PORT (pid $(cat "$GW_PID"), log $GW/gateway.log)"
}

# the preview's sandboxes and providers deleted through its gateway,
# started for it when down, then the gateway and its directory gone, so
# no container outlives the state that names it. The server is stopped
# first, so no warm pool refills meanwhile.
sandbox_clean() {
  [ -d "$GW" ] || return 0
  local id
  id=$(cat "$GW/instance" 2>/dev/null || true)
  if [ -n "$id" ] && [ -f "$GW/gateway.env" ]; then
    scripts/openshell.sh docker
    gw_sweep "$id"
  fi
  gw_stop
  rm -rf "$GW"
}

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
    # the preview admin's key: it makes the admin while the users table
    # is empty, and signs them in
    bun "$ENTRY" admin-key admin --secrets "$DIR/secrets" >/dev/null
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
  sandbox_clean
  rm -rf "$DIR"
  mkdir -p "$DIR/secrets"
  if [ -n "${2:-}" ]; then cp -R "$2"/. "$DIR/secrets/"; fi
  provision "$1"
}

start() {
  keys
  # no drain, since stop waits only five seconds for the exit
  ONECTX_DEV=1 nohup bun --watch "$ENTRY" \
    --listen "127.0.0.1:$PORT" --db "$DIR/1ctx.sqlite" \
    --secrets "$DIR/secrets" --drain 0 >"$LOG" 2>&1 &
  echo $! >"$PID"
  local pid holders
  pid=$(cat "$PID")
  for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "$URL/api/health"; then
      if listens "$pid"; then
        echo "preview up at $URL (pid $pid, log $LOG)"
        if [ "${PREVIEW_SHELL:-}" = sandbox ]; then sandbox; fi
        return 0
      fi
      holders=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -vx "$pid" | tr "\n" " " || true)
      if [ -n "$holders" ]; then
        echo "port $PORT is held by another process (pid ${holders% }); stop it or pick another PREVIEW_PORT" >&2
        stop
        exit 1
      fi
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
  stop) stop; gw_stop; echo "preview stopped" ;;
  clean) stop; sandbox_clean; rm -rf "$DIR"; echo "preview stopped, $DIR removed" ;;
  provision) provision "${2:-}" ;;
  reset) reset "${2:-}" "${3:-}" ;;
  restart) stop; start ;;
  status) if running; then echo "preview up at $URL (pid $(cat "$PID"))"; else echo "preview not running"; exit 1; fi ;;
  log) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|status|clean|provision <file>|reset <file> [secrets]|log [lines]" >&2; exit 1 ;;
esac
