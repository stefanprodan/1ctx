// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// set -e is off inside a command substitution outside posix mode, as
// bash 5.3 answered the same scripts.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the scripts are shell, where ${s:1} is a substring

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

const cases: [string, string, number][] = [
  ["set -e; x=$(( $(false; echo 1) )); echo ok $x", "ok 1\n", 0],
  ["set -e; (( y = $(false; echo 1) )); echo ok $y", "ok 1\n", 0],
  ["set -e; s=abc; echo ${s:$(false; echo 1)}", "bc\n", 0],
  [
    "set -e; for ((i=0; i<$(false; echo 2); i++)); do echo -n $i; done; echo",
    "01\n",
    0,
  ],
  ["set -e; x=$(false; echo 1); echo ok $x", "ok 1\n", 0],
  ["set -e; echo $(false; echo 1); echo after", "1\nafter\n", 0],
  ['set -e; x=$(set -e; false; echo 1); echo "ok [$x]"', "", 1],
  ["set -e; x=$(false); echo not reached", "", 1],
  ["set -e; y=$(set +e; echo 1); false; echo not reached", "", 1],
  ["set -o posix; set -e; x=$(false; echo 1); echo ok $x", "", 1],
  [
    'x=$(set -e; false; echo 1); echo "ok [$x]"; case $- in *e*) echo leaked;; *) echo clean;; esac',
    "ok []\nclean\n",
    0,
  ],
  [
    "set -euo pipefail; shopt -s inherit_errexit; x=$(false; echo 1); echo ok $x",
    "",
    1,
  ],
  [
    "set -e; shopt -s inherit_errexit; x=$(( $(false; echo 1) )); echo ok $x",
    "",
    1,
  ],
  [
    "set -e; shopt -s inherit_errexit; x=$(shopt -u inherit_errexit; false; echo 1); echo ok $x",
    "",
    1,
  ],
  ["shopt -s inherit_errexit; x=$(false; echo 1); echo ok $x", "ok 1\n", 0],
  [
    "shopt -s inherit_errexit; echo $BASHOPTS | tr : '\\n' | grep -c inherit_errexit",
    "1\n",
    0,
  ],
  ["shopt -p inherit_errexit", "shopt -u inherit_errexit\n", 1],
];

describe("set -e in a command substitution", () => {
  for (const [script, stdout, exitCode] of cases) {
    test(script, async () => {
      const r = await new Bash().exec(script);
      expect({ stdout: r.stdout, exitCode: r.exitCode }).toEqual({
        stdout,
        exitCode,
      });
    });
  }
});
