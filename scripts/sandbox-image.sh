#!/usr/bin/env bash
# Builds the sandbox image's variants for the native platform and loads
# each as 1ctx-shell:dev-<variant>, and under the registry name a source
# run's default image names, so the server finds it without a pull.
# VARIANT=go builds one. PLATFORMS instead builds those into the build
# cache only, a check that each platform builds.
set -euo pipefail
cd "$(dirname "$0")/../deploy/sandbox"

VARIANTS=(python bun go rust)
if [[ -n "${VARIANT:-}" ]]; then
  if [[ ! " ${VARIANTS[*]} " == *" $VARIANT "* ]]; then
    echo "VARIANT must be one of: ${VARIANTS[*]}" >&2
    exit 2
  fi
  VARIANTS=("$VARIANT")
fi

for variant in "${VARIANTS[@]}"; do
  args=(--file Dockerfile --target "$variant")
  if [[ -n "${PLATFORMS:-}" ]]; then
    args+=(--platform "$PLATFORMS" --output type=cacheonly)
  else
    args+=(--load --tag "1ctx-shell:dev-$variant"
      --tag "ghcr.io/stefanprodan/1ctx-shell:dev-$variant")
  fi
  docker buildx build "${args[@]}" .
done
