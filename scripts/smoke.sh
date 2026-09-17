#!/usr/bin/env bash
# Smoke test of the compiled binary: it starts, serves the page, answers
# health, bootstraps the admin from user-admin.key and signs it in with a
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
printf 'smoke-pass' >"$RUN/secrets/user-admin.key"
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

grep -q 'user-admin.key' "$RUN/log" || fail "user-admin.key was not read"

# Provision runs only after the listener is gone, against the same database.
kill "$PID"
wait "$PID"
unset PID
mkdir "$RUN/config" "$RUN/config/nested"
cat >"$RUN/config/01-project.yaml" <<'YAML'
apiVersion: config.1ctx.dev/v1
kind: Project
metadata:
  name: smoke-team
spec:
  members: [admin]
YAML
printf 'not an object\n' >"$RUN/config/README.txt"
printf 'not an object\n' >"$RUN/config/nested/ignored.yaml"
cat >"$RUN/admin.yml" <<'YAML'
apiVersion: config.1ctx.dev/v1
kind: User
metadata:
  name: admin
spec:
  role: admin
  fullName: Smoke Administrator
  tz: UTC
YAML
provision=$("$BIN" provision -f "$RUN/config" -f - \
  --db "$RUN/1ctx.sqlite" --secrets "$RUN/secrets" <"$RUN/admin.yml") \
  || fail "provision failed"
grep -q '^updated user/admin$' <<<"$provision" || fail "admin was not updated"
grep -q '^created project/smoke-team$' <<<"$provision" || fail "project was not created"
provision=$("$BIN" provision -f "$RUN/config" -f "$RUN/admin.yml" \
  --db "$RUN/1ctx.sqlite" --secrets "$RUN/secrets") || fail "reapply failed"
grep -q '^0 created, 0 updated, 2 unchanged$' <<<"$provision" \
  || fail "reapply changed an object"
if printf 'apiVersion: wrong\nkind: User\n' | "$BIN" provision -f - \
  --db "$RUN/refused.sqlite" --secrets "$RUN/secrets" >"$RUN/refusal" 2>&1; then
  fail "invalid input succeeded"
fi
[[ ! -e "$RUN/refused.sqlite" ]] || fail "preflight created a database"
if sed 's/\[admin\]/[missing-user]/' "$RUN/config/01-project.yaml" \
  | "$BIN" provision -f - --db "$RUN/refused.sqlite" \
    --secrets "$RUN/secrets" >"$RUN/refusal" 2>&1; then
  fail "missing reference succeeded"
fi
[[ ! -e "$RUN/refused.sqlite" ]] || fail "reference preflight created a database"
grep -q 'members' "$RUN/refusal" || fail "reference refusal did not name its field"
"$BIN" --version | grep -q '^v' || fail "version flag failed"
"$BIN" provision --help | grep -q '1ctx provision' || fail "provision help failed"
echo "smoke ok"
