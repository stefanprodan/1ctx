#!/usr/bin/env bash
# Smoke test of the compiled binary: it starts, serves the page, answers
# health, bootstraps the admin from user-admin.key and signs it in with a
# cookie. It runs outside the source directory and removes its files on exit.
set -euo pipefail
source "$(dirname "$0")/smoke-http.sh"

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

smoke_http

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
  description: The smoke test team.
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
