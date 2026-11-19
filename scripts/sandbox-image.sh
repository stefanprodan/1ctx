#!/usr/bin/env bash
# Builds the sandbox image for the native platform and loads it as
# 1ctx-shell:dev. PLATFORMS instead builds those into the build cache
# only, a check that each platform builds.
set -euo pipefail
cd "$(dirname "$0")/../deploy/sandbox"

args=(--file Dockerfile --tag 1ctx-shell:dev)
if [[ -n "${PLATFORMS:-}" ]]; then
  args+=(--platform "$PLATFORMS" --output type=cacheonly)
else
  args+=(--load)
fi
docker buildx build "${args[@]}" .
