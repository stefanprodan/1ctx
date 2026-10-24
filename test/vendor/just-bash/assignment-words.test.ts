// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A word holding = is a plain word in a for list, a case and an array
// literal: the stdout and exit code GNU bash 5.3.20 answered for the same
// scripts, but where a case says it pins our answer.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the scripts are shell, where ${u:-d} is a default

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

async function run(script: string) {
  const r = await new Bash({ env: { HOME: "/home/user" } }).exec(script);
  return { stdout: r.stdout, exitCode: r.exitCode };
}

// [script, stdout, exit code]
const cases: [string, string, number][] = [
  ["for s in SPY CL=F; do echo $s; done", "SPY\nCL=F\n", 0],
  ["for s in SPY CL=F\ndo echo $s; done", "SPY\nCL=F\n", 0],
  [
    `v=1; for x in a=$v "b=2" c=$(echo 3) d=*; do printf '[%s]' "$x"; done`,
    "[a=1][b=2][c=3][d=*]",
    0,
  ],
  ["for x in a={1,2} b=~; do echo $x; done", "a=1\na=2\nb=/home/user\n", 0],
  [
    "arr=(a=1 b=2); declare -p arr",
    'declare -a arr=([0]="a=1" [1]="b=2")\n',
    0,
  ],
  [
    "v=9; arr=(k=$v [3]=x m=); declare -p arr",
    'declare -a arr=([0]="k=9" [3]="x" [4]="m=")\n',
    0,
  ],
  ["declare -a d=(k=v); declare -p d", 'declare -a d=([0]="k=v")\n', 0],
  ["f() { local l=(x=1); declare -p l; }; f", 'declare -a l=([0]="x=1")\n', 0],
  [
    "arr=(a); arr+=(c=3); declare -p arr",
    'declare -a arr=([0]="a" [1]="c=3")\n',
    0,
  ],
  ["x=CL=F; case $x in CL=F) echo hit;; esac", "hit\n", 0],
  ["case k=v in k=*) echo hit;; esac", "hit\n", 0],
  ["case k=v in k=*|x=y) echo hit;; esac", "hit\n", 0],
  ["case $(echo a=b) in a=b) echo hit;; esac", "hit\n", 0],
  ["case a=b in (a=c) echo no;; (a=*) echo hit;; esac", "hit\n", 0],
  // a `do` followed by a separator and another `do` is a word
  ['for x in a do; do echo "[$x]"; done', "[a]\n[do]\n", 0],
  ['for x in a=1 do; do echo "[$x]"; done', "[a=1]\n[do]\n", 0],
  ['for x in do; do echo "[$x]"; done', "[do]\n", 0],
  ['for x in a b do\ndo echo "[$x]"; done', "[a]\n[b]\n[do]\n", 0],
  ['for x in a do;\ndo echo "[$x]"; done', "[a]\n[do]\n", 0],
  ['for x in a do\n\ndo echo "[$x]"; done', "[a]\n[do]\n", 0],
  ['for x in a do # c\ndo echo "[$x]"; done', "[a]\n[do]\n", 0],
  ['for x in a do do; do echo "[$x]"; done', "[a]\n[do]\n[do]\n", 0],
];

describe("words holding =", () => {
  for (const [script, stdout, exitCode] of cases) {
    test(script, async () => {
      expect(await run(script)).toEqual({ stdout, exitCode });
    });
  }
});

// Each pins our answer where it parts from bash, as vendor/differences.md
// records.
describe("words holding =, where we differ", () => {
  test("a tilde after = in an array element expands", async () => {
    // bash: declare -a arr=([0]="x=~")
    expect(await run("arr=(x=~); declare -p arr")).toEqual({
      stdout: 'declare -a arr=([0]="x=/home/user")\n',
      exitCode: 0,
    });
  });

  test("a tilde after : in a for word stays", async () => {
    // bash: c=x:/home/user
    expect(await run("for x in c=x:~; do echo $x; done")).toEqual({
      stdout: "c=x:~\n",
      exitCode: 0,
    });
  });

  test("declare rebuilds an array's words from their parts", async () => {
    // bash: declare -a d=([0]="a" [1]="b" [2]="3")
    expect(
      await run("declare -a d=(a $(echo b) $((1+2))); declare -p d"),
    ).toEqual({
      stdout:
        'declare -a d=([0]="a" [1]="CommandSubstitution" [2]="ArithmeticExpansion")\n',
      exitCode: 0,
    });
    // bash: declare -a d=([0]="d" [1]="k=d")
    expect(
      await run("u=; declare -a d=(${u:-d} k=${u:-d}); declare -p d"),
    ).toEqual({ stdout: 'declare -a d=([0]="k=")\n', exitCode: 0 });
  });

  test("a redirection target holding = is a parse error", async () => {
    // bash: hi
    expect(await run("echo hi > a=b; cat a=b")).toEqual({
      stdout: "",
      exitCode: 2,
    });
  });

  test("a do with no separator before it ends the list", async () => {
    // bash: a syntax error, exit 2
    expect(await run("for i in a b do echo $i; done")).toEqual({
      stdout: "a\nb\n",
      exitCode: 0,
    });
  });

  test("select is not a command", async () => {
    expect(await run("select x in a; do break; done")).toEqual({
      stdout: "",
      exitCode: 2,
    });
  });
});
