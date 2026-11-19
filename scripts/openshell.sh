#!/usr/bin/env bash
# OpenShell's gateway beside 1ctx: the pinned release binary, its
# certificates, its config and its state in one directory. The preview
# runs it as a child process (scripts/preview.sh); staging copies this
# file to the box and runs it as a LaunchAgent (scripts/staging.sh).
#
#   openshell.sh docker                        fail unless Docker answers
#   openshell.sh install <dir> <port> <label>  fetch and verify the binary, make the
#                                              certificates once, write the config;
#                                              prints "changed" when a running gateway
#                                              must restart to take it
#   openshell.sh run <dir>                     the gateway in the foreground
#   openshell.sh ports <dir>                   fail when another process holds a port
#   openshell.sh rotate <dir>                  the log moved to gateway.log.1
#   openshell.sh wait <dir> [pid]              until healthy on our own pid; fails at
#                                              once when the pid (or the LaunchAgent) exits
#   openshell.sh bundle <dir> <secrets-dir>    the client bundle as the openshell- keys
#   openshell.sh launchd <dir> [changed]       (re)start the LaunchAgent, then wait
set -euo pipefail

VERSION=0.1.9
# from the release's openshell-gateway-checksums-sha256.txt
sha_for() {
  case $1 in
    aarch64-apple-darwin) echo b348a57b97dc755d6a668631d328dd03fa88dc1b3565f16a094c9c59a420c51a ;;
    aarch64-unknown-linux-gnu) echo a41701c2dc7ac1aba13b0d48678dcb95090055aa42a2103b2ae712fb79338b1a ;;
    x86_64-unknown-linux-gnu) echo c32085d64ccef037121c0e87bee1a57d6e886d77f77bb8b260cb08f0a6cce6a3 ;;
    *) return 1 ;;
  esac
}
RELEASES=https://github.com/NVIDIA/OpenShell/releases/download
LABEL=dev.1ctx.openshell
# a gateway on port P serves its unauthenticated health on P + 10000, so
# two previews on two ports never share one
HEALTH_OFFSET=10000
WAIT_TRIES=150 # 30 s at 0.2 s: a healthy start takes about a second

# non-interactive ssh and launchd leave Docker Desktop's CLI off PATH
PATH=$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin

fail() { echo "openshell: $1" >&2; exit 1; }

target() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) echo aarch64-apple-darwin ;;
    Darwin/*) fail "OpenShell $VERSION publishes a macOS gateway for Apple silicon only" ;;
    Linux/x86_64) echo x86_64-unknown-linux-gnu ;;
    Linux/aarch64 | Linux/arm64) echo aarch64-unknown-linux-gnu ;;
    *) fail "no OpenShell $VERSION gateway for $(uname -s)/$(uname -m)" ;;
  esac
}

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi |
    cut -d' ' -f1
}

docker_up() {
  command -v docker >/dev/null || fail "docker not found; install and start Docker Desktop"
  docker info >/dev/null 2>&1 || fail "Docker is not running; start Docker Desktop"
}

install_() {
  local dir=$1 port=$2 label=$3 changed=
  if ! [[ $port =~ ^[0-9]+$ ]] || ((port == 0 || port + HEALTH_OFFSET >= 65536)); then
    fail "port must be between 1 and $((65535 - HEALTH_OFFSET))"
  fi
  local t sha
  t=$(target)
  sha=$(sha_for "$t")
  mkdir -p "$dir/bin" "$dir/state"
  chmod 700 "$dir"

  if [ "$(cat "$dir/bin/version" 2>/dev/null)" != "$VERSION $t" ]; then
    local name=openshell-gateway-$t.tar.gz tmp
    tmp=$(mktemp -d "$dir/fetch.XXXXXX")
    # a global, since the local is gone when the trap runs; read there,
    # never pasted into the trap's source
    FETCH_TMP=$tmp
    trap 'rm -rf "$FETCH_TMP"' EXIT
    curl -fsSL --retry 2 -o "$tmp/$name" "$RELEASES/v$VERSION/$name" ||
      fail "could not download $name"
    [ "$(sha256 "$tmp/$name")" = "$sha" ] ||
      fail "$name does not match its pinned sha256"
    tar -xzf "$tmp/$name" -C "$tmp" openshell-gateway
    # renamed over, never written in place: a running gateway keeps its
    # open file until it restarts
    mv -f "$tmp/openshell-gateway" "$dir/bin/openshell-gateway"
    rm -rf "$tmp"
    trap - EXIT
    echo "$VERSION $t" >"$dir/bin/version"
    changed=1
  fi

  # made once and kept: the client bundle 1ctx holds must keep matching
  if [ ! -f "$dir/tls/ca.crt" ]; then
    rm -rf "$dir/tls.new"
    "$dir/bin/openshell-gateway" generate-certs --output-dir "$dir/tls.new" \
      --server-san 127.0.0.1 --server-san localhost \
      --server-san host.openshell.internal >/dev/null 2>&1 ||
      fail "generate-certs failed"
    chmod -R go-rwx "$dir/tls.new"
    mv "$dir/tls.new" "$dir/tls"
    changed=1
  fi

  # Docker Desktop's socket, named so launchd's environment needs none
  local socket=
  socket=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
  case $socket in
    unix://*) socket="socket_path = \"${socket#unix://}\"" ;;
    *) socket= ;;
  esac

  # bridge networking: under Docker Desktop 127.0.0.1 is the supervisor
  # container's own, so it calls back by host.openshell.internal. Bind
  # mounts and no resource admission are for the repositories' binds;
  # push delivery loads a policy in milliseconds where polling takes
  # seconds. The label is the instance's own, so another gateway on this
  # Docker never kills our supervisors, nor ours its.
  cat >"$dir/gateway.toml.new" <<TOML
[openshell]
version = 2

[openshell.gateway]
compute_driver = "docker"
config_delivery_mode = "push"

[openshell.drivers.docker]
sandbox_label = "$label"
supervisor_network_mode = "bridge"
grpc_endpoint = "https://host.openshell.internal:$port"
allow_driver_config = true
enable_bind_mounts = true
$socket

[openshell.drivers.docker.resource_admission]
enabled = false
TOML
  # this script's own hash too: a new run() restarts the gateway
  printf 'PORT=%s\nHEALTH_PORT=%s\nSCRIPT=%s\n' "$port" \
    "$((port + HEALTH_OFFSET))" "$(sha256 "${BASH_SOURCE[0]}")" \
    >"$dir/gateway.env.new"
  for file in gateway.toml gateway.env; do
    if cmp -s "$dir/$file.new" "$dir/$file"; then
      rm -f "$dir/$file.new"
    else
      mv -f "$dir/$file.new" "$dir/$file"
      changed=1
    fi
  done
  [ -z "$changed" ] || echo changed
}

run() {
  local dir=$1
  # shellcheck disable=SC1091
  . "$dir/gateway.env"
  cd "$dir"
  export XDG_STATE_HOME="$dir/state" OPENSHELL_LOCAL_TLS_DIR="$dir/tls" \
    OPENSHELL_TELEMETRY_ENABLED=false
  # the listeners as flags: they win over the file, and the metrics one
  # stays off
  # shellcheck disable=SC2153
  exec "$dir/bin/openshell-gateway" --config "$dir/gateway.toml" \
    --bind-address 127.0.0.1 --port "$PORT" --health-port "$HEALTH_PORT" \
    --metrics-port 0
}

healthy() {
  # shellcheck disable=SC1091
  . "$1/gateway.env"
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$HEALTH_PORT/healthz"
}

agent_pid() {
  launchctl list "$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*"PID" = \([0-9]*\);/\1/p'
}

# without lsof every port reads free and no health listener is ours
command -v lsof >/dev/null 2>&1 || fail "lsof is needed to check the gateway's ports"
listeners() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

# A gateway on our port answers our health check, so a port another
# process holds is refused before ours starts and fails to bind.
ports() {
  local dir=$1 p pid
  # shellcheck disable=SC1091
  . "$dir/gateway.env"
  for p in "$PORT" "$HEALTH_PORT"; do
    for pid in $(listeners "$p"); do
      fail "port $p is held by another process (pid $pid); pick another gateway port (PREVIEW_GATEWAY_PORT or STAGING_GATEWAY_PORT)"
    done
  done
}

# the health listener is the given pid's, not a stranger's
owns() {
  # shellcheck disable=SC1091
  . "$1/gateway.env"
  [ -n "$2" ] && listeners "$HEALTH_PORT" | grep -qx "$2"
}

# launchd holds the log open while the gateway runs, so it moves only
# between a stop and a start, to one .1
rotate() {
  if [ -s "$1/gateway.log" ]; then mv -f "$1/gateway.log" "$1/gateway.log.1"; fi
}

# a pid, or "launchd" for the LaunchAgent, whose process may take a
# moment to appear after a bootstrap
wait_() {
  local dir=$1 pid=${2:-} gone=0 mine
  for _ in $(seq 1 "$WAIT_TRIES"); do
    case $pid in
      "") mine= ;;
      launchd) mine=$(agent_pid) ;;
      *) mine=$pid ;;
    esac
    if healthy "$dir" && { [ -z "$pid" ] || owns "$dir" "$mine"; }; then
      return 0
    fi
    case $pid in
      "") ;;
      launchd) if [ -n "$mine" ]; then gone=0; else gone=$((gone + 1)); fi ;;
      *) kill -0 "$pid" 2>/dev/null || gone=10 ;;
    esac
    if ((gone >= 10)); then
      echo "openshell: the gateway exited; log tail:" >&2
      tail -20 "$dir/gateway.log" >&2 || true
      exit 1
    fi
    sleep 0.2
  done
  echo "openshell: the gateway is not healthy after 30 s; log tail:" >&2
  tail -20 "$dir/gateway.log" >&2 || true
  exit 1
}

bundle() {
  local dir=$1 secrets=$2
  mkdir -p "$secrets"
  chmod 700 "$secrets"
  (
    umask 077
    cp "$dir/tls/ca.crt" "$secrets/openshell-gateway-ca.key"
    cp "$dir/tls/client/tls.crt" "$secrets/openshell-gateway-cert.key"
    cp "$dir/tls/client/tls.key" "$secrets/openshell-gateway-key.key"
  )
  chmod 600 "$secrets"/openshell-gateway-*.key
}

launchd() {
  local dir=$1 changed=${2:-} domain plist
  domain=gui/$(id -u)
  plist=$HOME/Library/LaunchAgents/$LABEL.plist
  mkdir -p "$HOME/Library/LaunchAgents"
  # KeepAlive brings a crashed gateway back; the throttle keeps it from
  # restarting twice in a row while its sandboxes are still in error
  cat >"$plist.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$dir/openshell.sh</string>
    <string>run</string>
    <string>$dir</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$dir</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$dir/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>$dir/gateway.log</string>
</dict>
</plist>
PLIST
  cmp -s "$plist.new" "$plist" || changed=1
  mv -f "$plist.new" "$plist"
  if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
    # an unchanged gateway keeps running: a restart drops every lease
    if [ -z "$changed" ]; then
      wait_ "$dir" launchd
      return
    fi
    launchctl bootout "$domain/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 100); do
      launchctl print "$domain/$LABEL" >/dev/null 2>&1 || break
      sleep 0.2
    done
  fi
  ports "$dir"
  rotate "$dir"
  bootstrap "$domain" "$plist"
  wait_ "$dir" launchd
}

bootstrap() {
  local out
  out=$(launchctl bootstrap "$1" "$2" 2>&1) && return 0
  # launchd answers 5 for a moment after a bootout of the same label
  if [[ $out == *"Bootstrap failed: 5"* ]]; then
    sleep 1
    out=$(launchctl bootstrap "$1" "$2" 2>&1) && return 0
  fi
  fail "launchctl bootstrap failed: $out"
}

case ${1:-} in
  docker) docker_up ;;
  install) install_ "${2:?dir}" "${3:?port}" "${4:?label}" ;;
  run) run "${2:?dir}" ;;
  ports) ports "${2:?dir}" ;;
  rotate) rotate "${2:?dir}" ;;
  wait) wait_ "${2:?dir}" "${3:-}" ;;
  bundle) bundle "${2:?dir}" "${3:?secrets dir}" ;;
  launchd) launchd "${2:?dir}" "${3:-}" ;;
  *) fail "usage: openshell.sh docker|install|run|ports|rotate|wait|bundle|launchd" ;;
esac
