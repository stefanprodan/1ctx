#!/usr/bin/env bash
# Copyright 2026 Stefan Prodan.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

cd "$(dirname "$0")"
export TZ=UTC LC_ALL=C
umask 022
TAR="${TAR:-gtar}"
if ! command -v "$TAR" >/dev/null; then TAR=tar; fi
"$TAR" --version | grep -q 'GNU tar'
command -v zip >/dev/null
command -v bun >/dev/null

# Keep all staging beneath this fixture directory, including the sparse files.
mkdir .make-archives
trap 'rm -rf .make-archives' EXIT
bun generate.ts prepare
tar_args=(--owner=0 --group=0 --numeric-owner --mtime=@946684800 --no-unquote)
pax_args=(--format=pax --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime)

"$TAR" "${tar_args[@]}" --format=ustar --no-recursion \
  -cf types.tar -C .make-archives/tree \
  docs/ docs/a.md 'docs\a.md' symlink hardlink fifo empty.md
gzip -n -c types.tar > types.tar.gz
"$TAR" "${tar_args[@]}" --format=ustar \
  -cf duplicate.tar -C .make-archives/first SKILL.md
"$TAR" "${tar_args[@]}" --format=ustar \
  -rf duplicate.tar -C .make-archives/second SKILL.md
"$TAR" "${tar_args[@]}" --format=gnu --sparse \
  -cf sparse-gnu.tar -C .make-archives/skill SKILL.md sparse.bin
"$TAR" "${tar_args[@]}" "${pax_args[@]}" --sparse --sparse-version=1.0 \
  -cf sparse-pax.tar -C .make-archives/skill SKILL.md sparse.bin
"$TAR" "${tar_args[@]}" "${pax_args[@]}" --no-recursion \
  -cf .make-archives/directories.tar -C .make-archives/directories \
  -T .make-archives/directories.list
gzip -n -c .make-archives/directories.tar > directories.tar.gz
"$TAR" "${tar_args[@]}" "${pax_args[@]}" --absolute-names \
  --transform='s|^absolute.md$|/abs.md|' \
  --transform='s|^parent.md$|../x.md|' \
  --transform='s|^back-parent.md$|..\\x.md|' \
  -cf names.tar -C .make-archives/names \
  -T .make-archives/names.list
"$TAR" "${tar_args[@]}" --format=gnu \
  -cf long-gnu.tar -C .make-archives/names \
  -T .make-archives/long.list

# Explicit member lists make order and timestamps independent of the filesystem.
rm -f stored.zip deflated.zip skill.zip encrypted.zip
(
  cd .make-archives/tree
  zip -q -X -0 -y ../../stored.zip docs/ docs/a.md 'docs\a.md' symlink empty.md
  zip -q -X -9 -y ../../deflated.zip docs/ docs/a.md 'docs\a.md' symlink empty.md large.md
)
(
  cd .make-archives/skill
  zip -q -X -9 ../../skill.zip SKILL.md references/guide.md
  zip -q -X -0 -P fixture-password ../../encrypted.zip SKILL.md
)
bun generate.ts craft
