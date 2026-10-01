#!/usr/bin/env bash
# Smoke test of the container image, run the way production runs it: the
# plain CMD, a fresh named volume, read-only secrets and provision folder,
# a read-only root and no capabilities. It signs the admin in, checks the
# provisioned project, stops the container with SIGTERM and requires a
# clean exit. It removes its container, volume and files.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/smoke-http.sh

IMAGE=ghcr.io/stefanprodan/1ctx:dev
PORT=${SMOKE_PORT:-1238}
URL=http://127.0.0.1:$PORT
NAME=1ctx-image-smoke-$$
RUN=$(mktemp -d "${TMPDIR:-/tmp}/1ctx-image-smoke.XXXXXX")
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME" >/dev/null 2>&1 || true
  rm -rf "$RUN"' EXIT

PLATFORMS='' scripts/image.sh

# the server runs as 65532, which owns neither the dirs nor the files
mkdir "$RUN/secrets" "$RUN/provision"
printf 'smoke-pass' >"$RUN/secrets/user-admin.key"
cat >"$RUN/provision/project.yaml" <<'YAML'
apiVersion: config.1ctx.dev/v1
kind: Project
metadata:
  name: smoke-team
spec:
  description: Applied at start.
YAML
chmod 755 "$RUN" "$RUN/secrets" "$RUN/provision"
chmod 644 "$RUN/secrets/user-admin.key" "$RUN/provision/project.yaml"

docker volume create "$NAME" >/dev/null
docker run -d --name "$NAME" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -v "$NAME:/data" -v "$RUN/secrets:/secrets:ro" \
  -v "$RUN/provision:/provision:ro" \
  -p "127.0.0.1:$PORT:11236" "$IMAGE" >/dev/null

fail() {
  echo "image-smoke: $1" >&2
  docker logs "$NAME" >&2 2>&1 || true
  exit 1
}

for _ in $(seq 1 100); do
  curl -sf -o /dev/null "$URL/api/health" && break
  [[ $(docker inspect -f '{{.State.Running}}' "$NAME") == true ]] \
    || fail "the container exited"
  sleep 0.2
done

smoke_http

projects=$(curl -sf -b "$RUN/cookies" "$URL/api/projects") \
  || fail "projects did not answer"
grep -q '"name":"smoke-team"' <<<"$projects" \
  || fail "the provisioned project is missing"

if [[ -n "${VERSION:-}" ]]; then
  health=$(get "$URL/api/health")
  grep -q "\"version\":\"$VERSION\"" <<<"$health" \
    || fail "health does not report $VERSION"
fi
log=$(docker logs "$NAME" 2>&1)
grep -q 'user-admin.key' <<<"$log" || fail "user-admin.key was not read"
grep -q 'provision_created=1 ' <<<"$log" \
  || fail "startup does not report the provisioned project"

docker stop -t 25 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[[ "$code" == 0 ]] || fail "the container exited with $code"
echo "image smoke ok"
