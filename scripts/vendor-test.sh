#!/usr/bin/env bash
# Runs just-bash's own suite on the vendored source under bun test and
# compares its failures and load errors with vendor/just-bash-failures.txt:
# the tests that fail upstream under Bun, or test what the trim removed. A
# new failure or one that passes now fails the run; `--update` rewrites the
# list.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/vendor/just-bash
LIST=$ROOT/vendor/just-bash-failures.txt
LOG=$(mktemp "${TMPDIR:-/tmp}/vendor-test.XXXXXX")
trap 'rm -f "$LOG" "$LOG.now"' EXIT

cd "$DIR"
bun test --preload ./src/vitest-setup.ts src >"$LOG" 2>&1 || true
grep -E '^ *[0-9]+ (pass|fail|errors?)$' "$LOG" | tr -s ' ' || true

if ! grep -qE '^ *[0-9]+ pass$' "$LOG"; then
  tail -40 "$LOG"
  echo "vendor-test: the suite did not run" >&2
  exit 1
fi

# A file that fails to load runs none of its tests, so its error is listed
# too, the first line of each, with the checkout's path taken out.
{
  awk '/^# Unhandled error/ { want = 1; next }
       want && /^error:/ { print; want = 0 }' "$LOG" |
    sed "s|$DIR/||g" || true
  grep '^(fail)' "$LOG" | sed -E 's/ \[[0-9.]+m?s\]$//' || true
} | LC_ALL=C sort -u >"$LOG.now"

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
