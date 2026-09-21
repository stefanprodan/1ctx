#!/usr/bin/env bash
# The staging instance: a Mac reached over ssh that runs the binary as a
# service (`1ctx service`), with its data under ~/.1ctx.
#
#   staging.sh deploy                     build, back the db up, swap the binary, restart
#   staging.sh provision <file|dir> [secrets-dir]
#                                         stop, apply the YAML objects, start
#   staging.sh status                     what the service says
#
# The host is named in scripts/staging.env, never here.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f scripts/staging.env ] || {
  echo "scripts/staging.env missing; copy scripts/staging.env.example" >&2
  exit 2
}
. scripts/staging.env
HOST=$STAGING_SSH
LISTEN=${STAGING_LISTEN:-0.0.0.0:11236}
KEEP_BACKUPS=3

# BatchMode fails fast instead of prompting
ssh_() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"; }
fail() { echo "staging: $1" >&2; exit 1; }

deploy() {
  # Staging holds real data and takes main only. A branch's migration is
  # frozen once it ran there, so deploying one is a deliberate bypass.
  local branch dirty sha
  branch=$(git rev-parse --abbrev-ref HEAD)
  dirty=$(git status --porcelain)
  if [ "${ALLOW_BRANCH:-}" != 1 ]; then
    [ "$branch" = main ] || fail "on $branch, not main; ALLOW_BRANCH=1 deploys it anyway"
    [ -z "$dirty" ] || fail "the checkout has uncommitted changes"
  fi
  sha=$(git rev-parse --short HEAD)
  # a dirty tree names its diff too, so two bypass deploys from one
  # commit are two versions and open tabs reload between them
  [ -z "$dirty" ] || sha=$sha.dirty$(git diff HEAD | shasum | cut -c1-6)
  local version
  version=v$(bun -e 'console.log(require("./package.json").version)')+$sha

  VERSION=$version make build
  [ "$(bin/1ctx -v)" = "$version" ] || fail "the binary does not report $version"

  # Before anything is swapped: .backup is safe on a live WAL database,
  # and the copy predates whatever migration the new binary brings.
  ssh_ KEEP="$KEEP_BACKUPS" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p ~/.1ctx/bin ~/.1ctx/backups
db=~/.1ctx/1ctx.sqlite
[ -f "$db" ] || exit 0
old=$(~/.1ctx/bin/1ctx -v 2>/dev/null || echo unknown)
out=~/.1ctx/backups/1ctx-$(date -u +%Y%m%dT%H%M%SZ)-$old.sqlite
sqlite3 "$db" ".backup '$out'"
# The copy inherits WAL mode and would grow -shm and -wal files the
# moment it is opened. A backup is one file: take it out of WAL first.
sqlite3 "$out" 'pragma journal_mode=delete' >/dev/null
rm -f "$out-shm" "$out-wal"
[ "$(sqlite3 "$out" 'pragma integrity_check')" = ok ] || {
  echo "staging: the backup failed its integrity check: $out" >&2
  exit 1
}
echo "backup: $out"
ls -1t ~/.1ctx/backups/1ctx-*.sqlite | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f" "$f-shm" "$f-wal"
done
REMOTE

  # Upload beside the live binary and rename: an interrupted copy must not
  # leave the service manager restarting a truncated executable.
  scp -q bin/1ctx "$HOST:~/.1ctx/bin/1ctx.new"
  ssh_ "mv -f ~/.1ctx/bin/1ctx.new ~/.1ctx/bin/1ctx &&
    ~/.1ctx/bin/1ctx service install --restart --listen $LISTEN"
}

provision() {
  local source=${1:-} keys=${2:-}
  [ -n "$source" ] || fail "provision needs FILE=<file|dir>"
  [ -e "$source" ] || fail "$source does not exist"
  # the copy is applied as a directory, which reads .yaml and .yml only
  if [ -f "$source" ]; then
    case $source in
      *.yaml | *.yml) ;;
      *) fail "$source must end in .yaml or .yml" ;;
    esac
  fi
  ssh_ 'test -x ~/.1ctx/bin/1ctx' || fail "no binary there yet; deploy first"

  if [ -n "$keys" ]; then
    [ -d "$keys" ] || fail "$keys is not a directory"
    ssh_ 'mkdir -p ~/.1ctx/secrets && chmod 700 ~/.1ctx/secrets'
    scp -q "$keys"/*.key "$HOST:~/.1ctx/secrets/"
    ssh_ 'chmod 600 ~/.1ctx/secrets/*.key'
  fi

  ssh_ 'rm -rf ~/.1ctx/provision.tmp && mkdir -m 700 ~/.1ctx/provision.tmp'
  if [ -d "$source" ]; then
    scp -q "$source"/*.y*ml "$HOST:~/.1ctx/provision.tmp/"
  else
    scp -q "$source" "$HOST:~/.1ctx/provision.tmp/"
  fi

  # Applying needs the database to itself. The service is started again
  # however this ends, a dropped connection included, and provision's
  # failure is the exit code.
  ssh_ bash -s <<'REMOTE'
set -uo pipefail
bin=~/.1ctx/bin/1ctx
code=1
finish() {
  rm -rf ~/.1ctx/provision.tmp
  "$bin" service start || code=1
  exit $code
}
"$bin" service stop || exit 1
trap finish EXIT HUP INT TERM
"$bin" provision -f ~/.1ctx/provision.tmp
code=$?
REMOTE
}

case ${1:-} in
  deploy) deploy ;;
  provision) provision "${2:-}" "${3:-}" ;;
  status) ssh_ '~/.1ctx/bin/1ctx service status' ;;
  *) fail "usage: staging.sh deploy|provision <file|dir> [secrets-dir]|status" ;;
esac
