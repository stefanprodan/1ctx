#!/usr/bin/env bash
# Runs just-bash's own suite on the vendored source under bun test and
# compares the failures with vendor/just-bash-failures.txt: the tests that
# fail upstream under Bun, or test what the trim removed. A new failure or
# one that passes now fails the run; `--update` rewrites the list.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LIST=$ROOT/vendor/just-bash-failures.txt
LOG=$(mktemp -t vendor-test)
trap 'rm -f "$LOG" "$LOG.now"' EXIT

cd "$ROOT/vendor/just-bash"
bun test --preload ./src/vitest-setup.ts src >"$LOG" 2>&1 || true
grep -E '^ *[0-9]+ (pass|fail|errors?)$' "$LOG" | tr -s ' ' || true

{
  grep -E '^# Unhandled error' -A8 "$LOG" |
    sed -nE "s|^error: (Cannot find package '[^']+').*|error: \1|p"
  grep '^(fail)' "$LOG" | sed -E 's/ \[[0-9.]+m?s\]$//'
} | LC_ALL=C sort -u >"$LOG.now"

if ! grep -qE '^ *[0-9]+ pass$' "$LOG"; then
  tail -40 "$LOG"
  echo "vendor-test: the suite did not run" >&2
  exit 1
fi

if [[ ${1:-} == --update ]]; then
  cp "$LOG.now" "$LIST"
  echo "vendor-test: wrote $(wc -l <"$LIST" | tr -d ' ') expected failures"
  exit 0
fi

if ! diff -u "$LIST" "$LOG.now"; then
  echo "vendor-test: failures differ from vendor/just-bash-failures.txt" >&2
  exit 1
fi
echo "vendor-test: ok, $(wc -l <"$LIST" | tr -d ' ') expected failures"
