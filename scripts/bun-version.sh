#!/usr/bin/env bash
# Prints the Bun version the Dockerfile pins, so CI, the release binaries
# and the image are built by the same Bun. It fails rather than print
# nothing, since setup-bun takes an empty version as the latest.
set -euo pipefail
cd "$(dirname "$0")/.."

versions=$(sed -nE 's|^FROM .*oven/bun:([0-9]+\.[0-9]+\.[0-9]+)@sha256:[0-9a-f]{64}.*|\1|p' Dockerfile)
if [[ $(wc -l <<<"$versions") -ne 1 || -z "$versions" ]]; then
  echo "bun-version: expected one oven/bun:<version>@sha256:<digest> line in the Dockerfile" >&2
  exit 1
fi
echo "$versions"
