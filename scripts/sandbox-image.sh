#!/usr/bin/env bash
# Builds the sandbox image's variants for the native platform and loads
# each as 1ctx-shell:dev-<variant>, and under the registry name a source
# run's default image names, so the server finds it without a pull.
# VARIANT=go builds one. PLATFORMS instead builds those into the build
# cache only, a check that each platform builds. The variants build on
# the base the Dockerfile pins, pulled from GHCR; BASE=local first
# builds base/Dockerfile, loaded as 1ctx-shell-base:dev and :dev-cc,
# and puts it in place of the pinned references.
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

contexts=()
case "${BASE:-}" in
"") ;;
local)
  # a loaded base is one platform's, so it cannot stand in for two
  if [[ -n "${PLATFORMS:-}" ]]; then
    echo "BASE=local builds the native platform only, without PLATFORMS" >&2
    exit 2
  fi
  for target in base cc; do
    tag=1ctx-shell-base:dev
    [[ "$target" == cc ]] && tag+=-cc
    docker buildx build --file base/Dockerfile --target "$target" --load \
      --tag "$tag" base
    # a named context keyed by the FROM's reference, tag and digest whole
    ref=$(sed -nE "s/^FROM (ghcr\.io\/[^ ]+\/1ctx-shell-base:[^ ]+) AS $target\$/\1/p" Dockerfile)
    if [[ -z "$ref" ]]; then
      echo "no pinned base for $target in Dockerfile" >&2
      exit 1
    fi
    contexts+=(--build-context "$ref=docker-image://$tag")
  done
  ;;
*)
  echo "BASE must be empty or local" >&2
  exit 2
  ;;
esac

for variant in "${VARIANTS[@]}"; do
  args=(--file Dockerfile --target "$variant" ${contexts[@]+"${contexts[@]}"})
  if [[ -n "${PLATFORMS:-}" ]]; then
    args+=(--platform "$PLATFORMS" --output type=cacheonly)
  else
    args+=(--load --tag "1ctx-shell:dev-$variant"
      --tag "ghcr.io/stefanprodan/1ctx-shell:dev-$variant")
  fi
  docker buildx build "${args[@]}" .
done
