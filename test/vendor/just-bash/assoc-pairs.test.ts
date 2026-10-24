// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An associative array assigned words with no [key]= takes them as key
// and value pairs, and local -A makes one: the stdout and exit code GNU
// bash 5.3.20 answered for the same scripts, but where a case says it
// pins our answer.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the scripts are shell, where ${m[k]} is an element

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

async function run(script: string) {
  const r = await new Bash().exec(script);
  return { stdout: r.stdout, exitCode: r.exitCode };
}

// [script, stdout, exit code]
const cases: [string, string, number][] = [
  ['declare -A m; m=(k v x y); echo "${m[k]}|${m[x]}|${#m[@]}"', "v|y|2\n", 0],
  [
    'declare -A m; m=(k v odd); echo "${m[k]}|[${m[odd]}]|${#m[@]}"',
    "v|[]|2\n",
    0,
  ],
  ['declare -A m; m=(a=1 b=2); echo "${m[a=1]}|${#m[@]}"', "b=2|1\n", 0],
  [
    'declare -A m=([a]=1); m+=(c 3); echo "${m[a]}|${m[c]}|${#m[@]}"',
    "1|3|2\n",
    0,
  ],
  ['declare -A m=([a]=1); m+=(a 9); echo "${m[a]}"', "9\n", 0],
  [
    'declare -A m=([a]=1); m=(c 3); echo "[${m[a]}]|${m[c]}|${#m[@]}"',
    "[]|3|1\n",
    0,
  ],
  ['declare -A m; m=("two words" v); echo "${m[two words]}"', "v\n", 0],
  ['declare -A m=([a]=1); m=(); echo "${#m[@]}"', "0\n", 0],
  // each word expands whole: no splitting, no globbing, "$@" joined
  ['declare -A m; l="p q"; m=($l v); echo "${m[p q]}"', "v\n", 0],
  ['declare -A m; m=($(echo k v)); echo "[${m[k v]}]|${#m[@]}"', "[]|1\n", 0],
  [
    'cd /tmp && : > g1 && : > g2 && declare -A m; m=(g* v); echo "${m[g*]}|${#m[@]}"',
    "v|1\n",
    0,
  ],
  ['declare -A m; set -- a b; m=("$@" v); echo "${m[a b]}"', "v\n", 0],
  // the first word alone picks pairs or keys
  ['declare -A m; m=(k v [x]=y); echo "${m[k]}|${#m[@]}"', "v|2\n", 0],
  // local -A makes an associative array, local to the function
  [
    "f(){ local -A s; for w in a b a c; do s[$w]=1; done; echo ${#s[@]}; }; f",
    "3\n",
    0,
  ],
  [
    'g=keep; f(){ local -A g; g[x]=1; g[y]=2; echo "${#g[@]}"; }; f; echo "$g"',
    "2\nkeep\n",
    0,
  ],
  ['f(){ local -A l=(k v); echo "${l[k]}"; }; f', "v\n", 0],
  [
    'dfs(){ local -A vis; vis[$1]=1; echo "${!vis[@]}"; [ $1 = a ] && dfs c; }; dfs a',
    "a\nc\n",
    1,
  ],
  [
    'f(){ local -A m; m[a]=1; h; echo "f:${!m[@]}"; }; h(){ local -A m; m[b]=2; echo "h:${!m[@]}"; }; f',
    "h:b\nf:a\n",
    0,
  ],
  [
    'g=(1 2); f(){ local -A g=(k v); echo "${g[k]}"; }; f; echo "${g[@]}"',
    "v\n1 2\n",
    0,
  ],
  [
    'declare -A o=([z]=9); f(){ local -A o; o[a]=1; echo "${!o[@]}"; }; f; echo "${!o[@]}|${o[z]}"',
    "a\nz|9\n",
    0,
  ],
  ['f(){ local -rA m=(k v); }; f; m=1; echo "$m"', "1\n", 0],
  ["declare -A G=([x]=1); f(){ local -A; }; f; echo rc=$?", "rc=0\n", 0],
  ['f(){ local -A m=([a]=1); local -A m; echo "${m[a]}"; }; f', "1\n", 0],
  // a [ past the first word does not make the list keyed
  ['f(){ local -A m=(k "[v]"); echo "${m[k]}|${#m[@]}"; }; f', "[v]|1\n", 0],
  ['f(){ local -A m=(k v [x]=y); echo "${m[k]}|${#m[@]}"; }; f', "v|2\n", 0],
  ['declare -A m=(k "[v]"); echo "${m[k]}|${#m[@]}"', "[v]|1\n", 0],
  ['declare -A m=( [a]=1 [b]=2 ); echo "${m[a]}${m[b]}"', "12\n", 0],
  [
    'f(){ local m; local -A m; m[a]=1; m[b]=2; echo "${#m[@]}|${m[a]}"; }; f',
    "2|1\n",
    0,
  ],
  [
    'f(){ local m=x; local -A m; m[k]=v; echo "${m[k]}|${#m[@]}"; }; f',
    "v|1\n",
    0,
  ],
  // the caller's variable comes back on return
  [
    'm=(g1 g2); f(){ local m; local -A m; m[k]=v; }; f; echo "${m[@]}"',
    "g1 g2\n",
    0,
  ],
  ['m=s; f(){ local m=x; local -A m; m[k]=v; }; f; echo "$m"', "s\n", 0],
  [
    'declare -A m=([x]=1 [y]=2); f(){ local m; local -A m; m[k]=v; }; f; echo "${#m[@]}"',
    "2\n",
    0,
  ],
  [
    'g(){ local m; local -A m; m[c]=3; }; f(){ local -a m=(1 2); g; echo "${m[@]}"; }; f',
    "1 2\n",
    0,
  ],
  [
    'r(){ local m; local -A m; m[d$1]=$1; [ $1 -lt 3 ] && r $(($1+1)); echo "$1:${#m[@]}:${!m[*]}"; }; r 1',
    "3:1:d3\n2:1:d2\n1:1:d1\n",
    0,
  ],
];

describe("associative arrays assigned pairs", () => {
  for (const [script, stdout, exitCode] of cases) {
    test(script, async () => {
      expect(await run(script)).toEqual({ stdout, exitCode });
    });
  }
});

// Each pins our answer where it parts from bash, as vendor/differences.md
// records.
describe("associative arrays assigned pairs, where we differ", () => {
  test("a brace in a pair's word expands", async () => {
    // bash: declare -A m=(["k{1,2}"]="v" )
    expect(await run('declare -A m; m=(k{1,2} v); echo "${m[k1 2]}"')).toEqual({
      stdout: "v\n",
      exitCode: 0,
    });
    // bash: {a,b}
    expect(await run('declare -A m; m=(k {a,b}); echo "${m[k]}"')).toEqual({
      stdout: "a b\n",
      exitCode: 0,
    });
  });

  test("local ignores -r", async () => {
    // bash: readonly variable, and exit 1
    expect(
      await run("f(){ local -Ar r=([a]=1); r[b]=2; }; f; echo rc=$?"),
    ).toEqual({ stdout: "rc=0\n", exitCode: 0 });
  });

  test("an empty key is stored", async () => {
    // bash: bad array subscript, and 0
    expect(await run('declare -A m; m=("" v); echo "${#m[@]}"')).toEqual({
      stdout: "1\n",
      exitCode: 0,
    });
  });
});
