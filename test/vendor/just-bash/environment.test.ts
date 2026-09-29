// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// awk's ENVIRON, jq's $ENV and env, and yq's env and strenv see the
// exported variables only, as gawk 5.4 and jq 1.8 under bash 5.3 do.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

async function run(script: string) {
  const bash = new Bash({ env: { KEPT: "k" }, cwd: "/" });
  return bash.exec(script);
}

const cases: [string, string][] = [
  [`X=1; awk 'BEGIN { print "x" ENVIRON["X"] }'`, "x\n"],
  [`export X=1; awk 'BEGIN { print ENVIRON["X"] }'`, "1\n"],
  [`X=1 awk 'BEGIN { print ENVIRON["X"] }'`, "1\n"],
  [`awk 'BEGIN { print ENVIRON["KEPT"] }'`, "k\n"],
  [`X=1; awk 'BEGIN { print ("X" in ENVIRON) }'`, "0\n"],
  [`export X=1; export -n X; awk 'BEGIN { print ("X" in ENVIRON) }'`, "0\n"],
  [`X=1; jq -n '$ENV.X'`, "null\n"],
  [`X=1; jq -n 'env.X'`, "null\n"],
  [`export X=1; jq -n '$ENV.X'`, '"1"\n'],
  [`X=1 jq -n 'env.X'`, '"1"\n'],
  [`jq -n '$ENV.KEPT'`, '"k"\n'],
  [`X=1; jq -n '$ENV | has("X")'`, "false\n"],
  [`X=1; yq -n 'strenv(X)'`, "\n"],
  [`export X=1; yq -n 'strenv(X)'`, "1\n"],
];

describe("a command's environment", () => {
  for (const [script, stdout] of cases) {
    test(script, async () => {
      const result = await run(script);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(stdout);
    });
  }
});
