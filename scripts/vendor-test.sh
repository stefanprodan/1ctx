#!/usr/bin/env bash
# Runs just-bash's own suite on the vendored source under bun test and
# compares its failures and load errors with vendor/just-bash-failures.txt:
# the tests that fail upstream under Bun, or test what the trim removed.
# Any difference fails the run, a new failure or a listed one passing.
# Every file runs in a fresh global, so no file sees another's leftovers;
# further arguments go to bun test, such as --parallel in CI. `--update`
# runs the suite twice and rewrites the list when both runs agree.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/vendor/just-bash
LIST=$ROOT/vendor/just-bash-failures.txt
LOG=$(mktemp "${TMPDIR:-/tmp}/vendor-test.XXXXXX")
trap 'rm -f "$LOG" "$LOG.now" "$LOG.first"' EXIT

update=false
if [[ ${1:-} == --update ]]; then
  update=true
  shift
fi

cd "$DIR"

# one run of the suite: its counts printed, its failures and load errors
# in $LOG.now
run() {
  bun test --isolate --preload ./src/vitest-setup.ts "$@" src >"$LOG" 2>&1 || true
  grep -E '^ *[0-9]+ (pass|skip|fail|errors?)$' "$LOG" | tr -s ' ' || true

  if ! grep -qE '^ *[0-9]+ pass$' "$LOG"; then
    tail -40 "$LOG"
    echo "vendor-test: the suite did not run" >&2
    exit 1
  fi

  # A file that fails to load runs none of its tests, so its error is
  # listed too: the file and the first error line of each, with the
  # checkout's path taken out.
  {
    awk '/^src\/.*\.test\.ts:$/ { file = $0; want = 0; seen = 0; next }
         /^# Unhandled error/ { want = 1; next }
         want && /^-+$/ && seen { want = 0; seen = 0; next }
         want && /^-+$/ { seen = 1; next }
         want && /^([A-Z][A-Za-z]*)?[Ee]rror: / { print file " " $0; want = 0; seen = 0 }' "$LOG" |
      sed "s|$DIR/||g" || true
    grep '^(fail)' "$LOG" | sed -E 's/ \[[0-9.]+m?s\]$//' || true
  } | LC_ALL=C sort -u >"$LOG.now"
}

run "$@"
if $update; then
  # only a set seen twice is recorded, so a flake shows up here first
  cp "$LOG.now" "$LOG.first"
  run "$@"
  if ! diff -u "$LOG.first" "$LOG.now"; then
    echo "vendor-test: two runs failed differently, nothing written" >&2
    exit 1
  fi
  cp "$LOG.now" "$LIST"
  echo "vendor-test: wrote $(wc -l <"$LIST" | tr -d ' ') expected failures"
  exit 0
fi

if ! diff -u "$LIST" "$LOG.now"; then
  # what bun said before each new failure, since the list keeps only names
  LC_ALL=C comm -13 "$LIST" "$LOG.now" | while IFS= read -r line; do
    grep -aF -B 30 -- "$line" "$LOG" | grep -av '^(pass)' | tail -30 || true
  done
  echo "vendor-test: failures differ from vendor/just-bash-failures.txt" >&2
  exit 1
fi
echo "vendor-test: ok, $(wc -l <"$LIST" | tr -d ' ') expected failures"
