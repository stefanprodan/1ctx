// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command substitution inside arithmetic runs in the script's own
// state, as bash 5.3 answered the same scripts.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the scripts are shell, where ${X:-d} is a default

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

const cases: [string, string, string?][] = [
  ["x=3; echo $(( ($(echo $x) + 1) / 2 ))", "2\n"],
  ["S='a b c d e'; echo $(( ($(printf '%s\\n' $S | wc -l) + 1) / 2 ))", "3\n"],
  ['X=abc; echo $(( $(echo "$X" | wc -c) ))', "4\n"],
  ["X=; echo $(( $(echo ${X:-DEFAULT} | wc -c) ))", "8\n"],
  ['export EE=zz; echo $(( $(echo "${EE:-none}" | wc -c) ))', "3\n"],
  ["f() { echo 2; }; echo $(( $(f) + 1 ))", "3\n"],
  [
    'x=2; f() { echo "$x"; }; echo $(( $(f; x=9; f() { echo 8; }) + 1 )); f; echo $x',
    "3\n2\n2\n",
  ],
  [
    'echo $(( $(set -f; echo 1) )); case "$-" in *f*) echo leaked;; *) echo clean;; esac',
    "1\nclean\n",
  ],
  ["cd /tmp; echo $(( $(pwd | wc -c) ))", "5\n"],
  ["x=5; (( y = $(echo $x) * 2 )); echo $y", "10\n"],
  ["a=4; echo $(( `echo $a` + 1 ))", "5\n"],
  [
    "n=3; for ((i = 0; i < $(echo $n); i++)); do echo -n $i; done; echo",
    "012\n",
  ],
  ['x=7; echo "${x:$(( $(echo 0) ))}"', "7\n"],
  ["echo $(( $(echo oops >&2; echo 4) + 1 ))", "5\n", "oops\n"],
  ["echo $(( $(false; echo 6) )); echo $?", "6\n0\n"],
];

describe("arithmetic command substitution", () => {
  for (const [script, stdout, stderr = ""] of cases) {
    test(script, async () => {
      const r = await new Bash().exec(script);
      expect({ stdout: r.stdout, stderr: r.stderr }).toEqual({
        stdout,
        stderr,
      });
    });
  }
});
