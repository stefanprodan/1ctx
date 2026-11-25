# What every variant of the sandbox image promises, and the harness the
# variant files use. scripts/sandbox-image-check.ts sends this file, the
# variant's and one call to a sandbox through the backend, as a command
# of the bash tool. EXPECT_<TOOL> is the minor the bash tool's
# description names (SHELL_VERSIONS), never a literal here.
#
# A check is a function run with set -e and pipefail in a fresh folder
# under HOME, where the toolchains keep their caches; the runner fails
# a check that writes to /knowledge, which a turn saves. set -e does not see a
# failure in `local x=$(...)` or before && mid-function: assign apart,
# and end a chain with a command that fails. Only an online check
# reaches the network, and a variant has at most one.

failed=0

check() {
  local name=$1 dir out rc
  dir=$(mktemp -d "$HOME/image-check.XXXXXX")
  # bash ignores set -e in a condition, so the status is read after
  out=$(
    cd "$dir" || exit 1
    set -eo pipefail
    "$2" 2>&1
  )
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    [ -n "$out" ] || out="exit $rc, no output"
    printf '%s\n' "$out" | tail -n 8 | sed 's/^/    /'
    failed=1
  fi
}

# eq <got> <want>: an assertion that says what it saw
eq() {
  [ -n "$2" ] || {
    echo "nothing to compare '$1' with"
    return 1
  }
  [ "$1" = "$2" ] || {
    echo "got '$1', want '$2'"
    return 1
  }
}

# minor <version text>: the first x.y in it
minor() { grep -oE '[0-9]+\.[0-9]+' <<<"$1" | head -n 1; }

common_user() {
  eq "$(id -un)" sandbox
  eq "$(id -u)" 1000
}

common_writes() {
  touch "$HOME/w" "$TMPDIR/w"
  rm "$HOME/w" "$TMPDIR/w"
  local d
  for d in /usr/bin /usr/lib /usr/local/bin; do
    if touch "$d/w" 2>/dev/null; then
      echo "$d is writable"
      return 1
    fi
  done
}

# each one runs, so a missing library or a wrong architecture fails
common_tools() {
  local t
  for t in bash bc bzip2 column curl envsubst file git hexdump jq less \
    make patch perl python3 rg rsync sqlite3 tar tree uv uvx wget xz \
    yq zip zstd; do
    "$t" --version </dev/null >/dev/null || {
      echo "$t does not run"
      return 1
    }
  done
  unzip -v >/dev/null
  lua -v >/dev/null
  pdftotext -v 2>/dev/null
}

# tar through each compressor, and zip, each archive unpacked again
common_archives() {
  mkdir in
  printf 'abc\n' >in/f
  local z
  for z in xz zstd bzip2; do
    tar -caf "a.tar.$z" in
    mkdir "out-$z"
    tar -xaf "a.tar.$z" -C "out-$z"
    eq "$(cat "out-$z/in/f")" abc
  done
  zip -qr a.zip in
  unzip -q a.zip -d out-zip
  eq "$(cat out-zip/in/f)" abc
}

# JSON::PP is outside perl-base, so a bare perl-base fails
common_scripts() {
  eq "$(perl -MJSON::PP -e 'print encode_json([42])')" "[42]"
  eq "$(lua -e 'print(6*7)')" 42
}

# a lookbehind, which only PCRE2 reads, so a build without it fails
common_git() {
  git init -q repo
  cd repo
  git config user.name check
  git config user.email check@example.invalid
  printf 'abc123\n' >f
  git add f
  git commit -q -m one
  eq "$(git log --format=%s)" one
  eq "$(git show HEAD:f)" abc123
  eq "$(git grep -P -h -o '(?<=abc)\d+')" 123
}

# offline, so a refused connection is the pass: libcurl ran in the
# helper; a missing helper says it is not found
common_git_https() {
  local out
  if out=$(git ls-remote https://127.0.0.1:9/x.git 2>&1); then
    echo "ls-remote reached 127.0.0.1:9"
    return 1
  fi
  case $out in
  *"unable to access"*) ;;
  *)
    printf '%s\n' "$out"
    return 1
    ;;
  esac
}

common_rg() {
  printf 'abc123\n' >f
  eq "$(rg --pcre2 -o '(?<=abc)\d+' f)" 123
}

common_python() {
  eq "$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')" \
    "$EXPECT_PYTHON"
}

offline_common() {
  check "runs as the sandbox user" common_user
  check "HOME and TMPDIR are writable, /usr is not" common_writes
  check "the base tools run" common_tools
  check "tar and zip pack and unpack" common_archives
  check "perl modules and lua load" common_scripts
  check "git commits and greps with -P" common_git
  check "git has its https helper" common_git_https
  check "rg searches with --pcre2" common_rg
  check "python is $EXPECT_PYTHON" common_python
}

# a variant file defines offline_variant and, when its toolchain fetches
# from a registry, online_variant
run_offline() {
  offline_common
  offline_variant
  return "$failed"
}

run_online() {
  if declare -F online_variant >/dev/null; then online_variant; fi
  return "$failed"
}
