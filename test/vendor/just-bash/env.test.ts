// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// env, printenv and a child shell see the exported environment, as GNU
// coreutils 9.11 env and bash 5.3 answered the same commands.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

async function run(script: string) {
  const bash = new Bash({ env: { KEPT: "k" }, cwd: "/" });
  return bash.exec(script);
}

const cases: [string, string, number?][] = [
  ["env SLOT=1 sh -c 'echo $SLOT'", "1\n"],
  ["env A=1 B=2 sh -c 'echo $A$B$KEPT'", "12k\n"],
  ["export E=5; env sh -c 'echo $E'", "5\n"],
  ["E=5; env sh -c 'echo x$E'", "x\n"],
  ["SLOT=2 env sh -c 'echo $SLOT'", "2\n"],
  ["env -i A=1 sh -c 'echo $A:$KEPT'", "1:\n"],
  ["env -u KEPT sh -c 'echo x$KEPT'", "x\n"],
  ["env --unset KEPT sh -c 'echo x$KEPT'", "x\n"],
  ["env -iu KEPT A=3 sh -c 'echo $A$KEPT'", "3\n"],
  ["env - A=4 sh -c 'echo $A$KEPT'", "4\n"],
  ["env -- A=5 sh -c 'echo $A'", "5\n"],
  ["env SLOT=1 sh -c 'sh -c \"echo \\$SLOT\"'", "1\n"],
  ["env -i A=1 B=2 env", "A=1\nB=2\n"],
  ["env -i A=1 B=2", "A=1\nB=2\n"],
  ["X=1; env | grep -c '^X='", "0\n", 1],
  ["export X=1; env | grep '^X='", "X=1\n"],
  ["X=1; printenv X", "", 1],
  ["sh -c 'printenv | grep -c \"^[0-9#@*]=\"'", "0\n", 1],
  ["unset KEPT; sh -c 'echo x$KEPT'", "x\n"],
  ["env -i sh -c 'x=\"a b\"; for i in $x; do echo $i; done'", "a\nb\n"],
  ["env A=1 -i sh -c 'echo $A'", "", 127],
  ["env -i IFS=a sh -c 'v=bab; echo $v'", "bab\n"],
  ["export IFS=:; sh -c 'v=a:b; echo $v'", "a:b\n"],
  ["env IFS=a printenv IFS", "a\n"],
  ["export X=1; timeout 5 sh -c 'echo t$X'", "t1\n"],
  ["X=1; timeout 5 sh -c 'echo t$X'", "t\n"],
  ["export X=1; find / -maxdepth 0 -exec printenv X ';'", "1\n"],
  ["export X=1; find / -maxdepth 0 -exec sh -c 'echo $X' sh {} +", "1\n"],
  ["export -n HOME; time printenv HOME", "", 1],
  ["export X=1; time sh -c 'echo t$X'", "t1\n"],
  ["f(){ local -x L=1; sh -c 'echo l$L'; }; f", "l1\n"],
  ["f(){ local -x L=1; }; L=2; f; sh -c 'echo x$L'", "x\n"],
  ["export -n KEPT; echo a | xargs sh -c 'echo x$KEPT'", "x\n"],
];

describe("env and the exported environment", () => {
  for (const [script, stdout, exitCode = 0] of cases) {
    test(script, async () => {
      const r = await run(script);
      expect(r.stdout).toBe(stdout);
      expect(r.exitCode).toBe(exitCode);
    });
  }

  test("env refuses -u without a name as GNU does, exit 125", async () => {
    const r = await run("env -u");
    expect(r.stderr).toBe("env: option requires an argument -- 'u'\n");
    expect(r.exitCode).toBe(125);
  });

  for (const name of ["B=1", ""]) {
    test(`env refuses to unset '${name}' as glibc does, exit 125`, async () => {
      const r = await run(`env -u '${name}' true`);
      expect(r.stderr).toBe(`env: cannot unset '${name}': Invalid argument\n`);
      expect(r.exitCode).toBe(125);
    });
  }

  test("env refuses an unknown option, exit 125", async () => {
    const r = await run("env -z true");
    expect(r.stderr).toBe("env: invalid option -- 'z'\n");
    expect(r.exitCode).toBe(125);
  });
});
