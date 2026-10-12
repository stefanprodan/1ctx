#!/usr/bin/env bash
# Setup for a Claude Code cloud environment whose sessions work 1ctx
# external tasks in this repository. The environment's setup script runs
# it as root before Claude Code starts, after the repository is cloned:
#
#   bash /home/user/1ctx/scripts/cloud-setup.sh
#
# ONECTX_URL, set on the environment, names the instance; its host must
# be allowed in the environment's network access. /mcp comes from a
# claude.ai connector with the access key in its request headers, so
# nothing here holds a key.
set -euo pipefail
cd "$(dirname "$0")/.."
# a copy of the output the session can read
exec > >(tee /var/log/onectx-setup.log) 2>&1
echo "cloud-setup: start $(date -u +%FT%TZ)"

: "${ONECTX_URL:?cloud-setup: set ONECTX_URL on the environment}"
want=$(scripts/bun-version.sh)

# from the GitHub release, which the Trusted network level allows
if [[ "$(bun --version 2>/dev/null || true)" != "$want" ]]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) echo "cloud-setup: unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v${want}/bun-linux-${arch}.zip"
  python3 -m zipfile -e "$tmp/bun.zip" "$tmp"
  # the image ships its own Bun earlier on the PATH, so the one the PATH
  # finds is replaced, and /usr/local/bin for shells with another PATH
  current=$(command -v bun || true)
  echo "cloud-setup: replacing ${current:-no bun} with $want"
  for target in ${current:+"$(readlink -f "$current")"} /usr/local/bin/bun; do
    install -m 0755 "$tmp/bun-linux-${arch}/bun" "$target"
  done
  rm -rf "$tmp"
  hash -r
fi
if [[ "$(bun --version)" != "$want" ]]; then
  echo "cloud-setup: bun is $(bun --version) at $(command -v bun), want $want" >&2
  exit 1
fi
echo "cloud-setup: bun $want at $(command -v bun)"

# the skill from the instance, so its tool actions match the build that
# serves /mcp rather than this checkout
skill_dir="$HOME/.claude/skills/external-tasks"
mkdir -p "$skill_dir"
if ! curl -fsS --max-time 20 -o "$skill_dir/SKILL.md" \
  "${ONECTX_URL%/}/.well-known/skills/external-tasks/SKILL.md"; then
  echo "cloud-setup: cannot fetch the skill from $ONECTX_URL; allow its host in the network access" >&2
  exit 1
fi
echo "cloud-setup: skill $(sed -n 2p "$skill_dir/SKILL.md")"
echo "cloud-setup: done"
