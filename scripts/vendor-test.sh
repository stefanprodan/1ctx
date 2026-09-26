#!/usr/bin/env bash
# Runs just-bash's own suite on the vendored source under bun test and
# compares its failures and load errors with vendor/just-bash-failures.txt:
# the tests that fail upstream under Bun, or test what the trim removed. A
# new failure fails the run unless its file passes when run alone, and so
# does one that passes now; `--update` rewrites the list.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/vendor/just-bash
LIST=$ROOT/vendor/just-bash-failures.txt
LOG=$(mktemp "${TMPDIR:-/tmp}/vendor-test.XXXXXX")
trap 'rm -f "$LOG" "$LOG.now" "$LOG.new" "$LOG.files" "$LOG.alone"' EXIT

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

comm -13 "$LIST" "$LOG.now" >"$LOG.new"
# The suite shares one process and static state, such as ReadWriteFs's
# mutation queue, so under load a test can fail for another file's
# leftovers. A new failure whose file passes when run alone is that, and
# a regression fails there too. Load errors and fixed tests stay strict.
flaky=false
if [[ -s $LOG.new ]] && ! comm -23 "$LIST" "$LOG.now" | grep -q . &&
  ! grep -q '^error:' "$LOG.new"; then
  awk '/^src\/.*\.test\.ts:$/ { file = substr($0, 1, length($0) - 1); next }
       /^\(fail\) / { sub(/ \[[0-9.]+m?s\]$/, ""); print file "\t" $0 }' "$LOG" |
    grep -F -f "$LOG.new" >"$LOG.files" || true
  files=$(cut -f1 "$LOG.files" | sort -u)
  # every new failure must be traced to its file, or it stays strict
  if [[ $(cut -f2 "$LOG.files" | sort -u | wc -l) -ne $(wc -l <"$LOG.new") ]]; then
    files=""
  fi
  if [[ -n $files ]]; then
    # shellcheck disable=SC2086
    bun test --preload ./src/vitest-setup.ts $files >"$LOG.alone" 2>&1 || true
    if grep -qE '^ *[0-9]+ pass$' "$LOG.alone" &&
      ! sed -E 's/ \[[0-9.]+m?s\]$//' "$LOG.alone" | grep -qxF -f "$LOG.new"; then
      flaky=true
    fi
  fi
fi

if [[ $flaky == true ]]; then
  echo "vendor-test: passed alone, failed only beside other files:"
  sed 's/^/  /' "$LOG.new"
elif ! diff -u "$LIST" "$LOG.now"; then
  # what bun said before each new failure, since the list keeps only names
  while IFS= read -r line; do
    grep -F -B 30 "$line" "$LOG" | grep -v '^(pass)' | tail -30 || true
  done <"$LOG.new"
  echo "vendor-test: failures differ from vendor/just-bash-failures.txt" >&2
  exit 1
fi
echo "vendor-test: ok, $(wc -l <"$LIST" | tr -d ' ') expected failures"
