// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// awk's ENVIRON and the commands it runs, jq's $ENV and env, yq's env
// and strenv, and the TZ date and diff read see the exported variables
// only, as gawk 5.4, jq 1.8 and GNU coreutils under bash 5.3 do.

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
  // awk's children get ENVIRON as it stands, string changes included
  [
    `export W=4; Y=2; awk 'BEGIN { "echo a$W-$Y" | getline v; print v }'`,
    "a4-\n",
  ],
  [
    `export X=1; awk 'BEGIN { ENVIRON["X"] = "nine"; ENVIRON["Z"] = "three"; "echo b$X-$Z" | getline v; print v }'`,
    "bnine-three\n",
  ],
  [
    `export W=4; awk 'BEGIN { delete ENVIRON["W"]; "echo c$W" | getline v; print v }'`,
    "c\n",
  ],
  [
    `export W=4; Y=2; echo in | awk '{ print | "cat; echo $W-$Y" }'`,
    "in\n4-\n",
  ],
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

// the zone date and diff's headers read: only an exported TZ, a prefix
// assignment included, moves them off UTC
const zones: [string, string][] = [
  ["TZ=Asia/Tokyo; ", "+0000"],
  ["export TZ=Asia/Tokyo; ", "+0900"],
  ["TZ=Asia/Tokyo ", "+0900"],
  ["export TZ=Asia/Tokyo; export -n TZ; ", "+0000"],
];

describe("TZ", () => {
  for (const [set, offset] of zones) {
    test(`${set}date and diff`, async () => {
      const bash = new Bash({ cwd: "/" });
      await bash.exec("echo a > /a; echo b > /b");
      const date = await bash.exec(`${set}date -d @0 +%z`);
      expect(date.stdout).toBe(`${offset}\n`);
      const diff = await bash.exec(`${set}diff -u /a /b`);
      expect(diff.stdout.split("\n")[0]!.endsWith(` ${offset}`)).toBeTrue();
    });
  }

  test("printf's %()T reads an exported TZ", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "export TZ=Asia/Tokyo; printf '%(%z)T\\n' 0",
    );
    expect(result.stdout).toBe("+0900\n");
  });
});
