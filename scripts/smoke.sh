#!/usr/bin/env bash
# Smoke test of the compiled binary: it starts, serves the page, answers
# health, bootstraps the admin from admin.key and signs it in with a
# cookie. It runs outside the source directory and removes its files on exit.
set -euo pipefail

BIN=${1:-bin/1ctx}
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")
PORT=${SMOKE_PORT:-1237}
URL=http://127.0.0.1:$PORT
RUN=bin/smoke-$$
mkdir -p bin
mkdir "$RUN"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$RUN"' EXIT

mkdir -p "$RUN/secrets"
printf 'smoke-pass' >"$RUN/secrets/admin.key"
(cd "$RUN" && exec "$BIN" --listen "127.0.0.1:$PORT" --db 1ctx.sqlite \
  --secrets secrets) >"$RUN/log" 2>&1 &
PID=$!

for _ in $(seq 1 50); do
  curl -sf -o /dev/null "$URL/api/health" && break
  kill -0 "$PID" 2>/dev/null || { cat "$RUN/log"; exit 1; }
  sleep 0.2
done

fail() { echo "smoke: $1" >&2; cat "$RUN/log" >&2; exit 1; }

# a body is read into a variable and grepped there: grep -q piped from
# curl stops at the first match, curl then dies of the broken pipe, and
# pipefail turns a good answer into a failure whenever curl loses the race
get() { curl -sf "$1" || fail "GET $1 did not answer"; }

health=$(get "$URL/api/health")
grep -q '"ok":true' <<<"$health" || fail "health is not ok"
page=$(get "$URL/")
grep -q '<div id="app">' <<<"$page" || fail "the page did not render"
script=$(grep -o 'src="[^"]*\.js"' <<<"$page" | head -1 | cut -d'"' -f2)
[[ -n "$script" ]] || fail "the page has no script"
chunk=$(get "$URL$script")
grep -q 'preact\|render' <<<"$chunk" || fail "the script did not serve"

login=$(curl -s -c "$RUN/cookies" -o /dev/null -w '%{http_code} %{header_json}' \
  -H 'content-type: application/json' -H "origin: $URL" \
  -d '{"username":"admin","password":"smoke-pass"}' "$URL/api/login")
[[ "$login" == 200* ]] || fail "login answered ${login%% *}"
echo "$login" | grep -q 'login=' || fail "login set no cookie"

curl -sf -b "$RUN/cookies" -D "$RUN/visual-headers" \
  -o "$RUN/visual.html" "$URL/api/visual" || fail "visual shell did not answer"
grep -q 'var Idiomorph=function' "$RUN/visual.html" \
  || fail "the compiled visual shell has no Idiomorph"
grep -qi 'content-security-policy: sandbox allow-scripts' "$RUN/visual-headers" \
  || fail "the visual shell has no sandbox header"
grep -qi 'connect-src.*none' "$RUN/visual-headers" \
  || fail "the visual shell allows connections"

wrong=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' -H "origin: $URL" \
  -d '{"username":"admin","password":"nope"}' "$URL/api/login")
[[ "$wrong" == 401 ]] || fail "a wrong password answered $wrong"

cross=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' -H 'origin: http://evil.test' \
  -d '{"username":"admin","password":"smoke-pass"}' "$URL/api/login")
[[ "$cross" == 403 ]] || fail "a cross-origin write answered $cross"

grep -q 'admin.key' "$RUN/log" || fail "admin.key was not read"
echo "smoke ok"
