// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// read and mapfile take UTF-8 text from every input as characters, as
// bash 5.3 answered the same scripts in a UTF-8 locale.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the scripts are shell, where ${#x} is a length

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

const setup =
  "printf 'café\\n' > f; printf 'café\\nţară\\n' > two; " +
  "printf 'ţară ăîș 😀 x\\n' > r; printf 'aébéc' > g; " +
  "printf 'éa\\0ţb\\0' > nul; ";

const cases: [string, string][] = [
  ['read x < f; echo "$x ${#x}"', "café 4\n"],
  ['read -r x < f; echo "$x ${#x}"', "café 4\n"],
  ['printf "café\\n" | { read y; echo "$y ${#y}"; }', "café 4\n"],
  ['while read l; do echo "$l ${#l}"; done < two', "café 4\nţară 4\n"],
  [
    'cat two | while IFS= read -r l; do echo "${#l}:$l"; done',
    "4:café\n4:ţară\n",
  ],
  ['exec 3< two; read -u 3 a; read -u 3 b; echo "${#a}|${#b}"', "4|4\n"],
  ['exec 3< two; read a <&3; read b <&3; echo "${#a}|${#b}"', "4|4\n"],
  ['{ read a; read b; } < two; echo "${#a}|${#b}"', "4|4\n"],
  ['read z <<< "café"; echo "$z ${#z}"', "café 4\n"],
  ['read h <<EOF\ncafé ţ\nEOF\necho "$h ${#h}"', "café ţ 6\n"],
  ['read p < <(printf "café\\n"); echo "$p ${#p}"', "café 4\n"],
  [
    'read a b c < r; echo "[$a][$b][$c] ${#a} ${#c}"',
    "[ţară][ăîș][😀 x] 4 3\n",
  ],
  ['IFS=ă read u v < r; echo "[$u][$v]"', "[ţar][ ăîș 😀 x]\n"],
  ['IFS= read v < r; echo "${#v}"', "12\n"],
  [
    'read -a arr < r; echo "${#arr[@]} ${arr[1]} ${#arr[2]} ${arr[2]}"',
    "4 ăîș 1 😀\n",
  ],
  [
    '{ read -d "" a; read -d "" b; } < nul; echo "$a ${#a} $b ${#b}"',
    "éa 2 ţb 2\n",
  ],
  ['{ read -n 4 a; read -r b; } < two; echo "[$a][$b]"', "[café][]\n"],
  ['{ read -n 3 a; read -r b; } < two; echo "[$a][$b]"', "[caf][é]\n"],
  ['{ read -N 4 a; read -r b; } < two; echo "[$a][${#b}]"', "[café][0]\n"],
  ['{ read -N 7 a; read -r b; } < two; echo "[${#a}][$b]"', "[7][ră]\n"],
  [
    '{ read -n 1 a; read -n 1 b; read -r c; } < r; echo "[$a][$b][$c]"',
    "[ţ][a][ră ăîș 😀 x]\n",
  ],
  ['printf "😀😀x\\n" | { read -n 1 v; read -r w; echo "$v|$w"; }', "😀|😀x\n"],
  ['printf "😀😀x\\n" | { read -N 2 v; echo "$v ${#v}"; }', "😀😀 2\n"],
  ['printf "a\\\\éb\\n" | { read v; echo "$v ${#v}"; }', "aéb 3\n"],
  ['printf "\\\\éxy\\n" | { read -n 2 v; echo "$v"; }', "éx\n"],
  ['read -d é p < g; echo "[$p]"', "[a]\n"],
  ['read -d ab p <<< "xxbyyazz"; echo "[$p]"', "[xxbyy]\n"],
  [
    'mapfile -t a < two; echo "${#a[@]} ${a[0]} ${#a[0]} ${a[1]} ${#a[1]}"',
    "2 café 4 ţară 4\n",
  ],
  [
    'mapfile a < two; echo "${#a[0]}"; printf "%s" "${a[@]}"',
    "5\ncafé\nţară\n",
  ],
  ['readarray -t a < r; echo "${a[0]} ${#a[0]}"', "ţară ăîș 😀 x 12\n"],
  ['cat two | { mapfile -t a; echo "${a[1]} ${#a[1]}"; }', "ţară 4\n"],
  ['mapfile -t -s 1 a < two; echo "${a[0]} ${#a[0]} ${#a[@]}"', "ţară 4 1\n"],
  ['mapfile -t -n 1 a < two; echo "${a[0]} ${#a[0]} ${#a[@]}"', "café 4 1\n"],
  [
    'a=(x); mapfile -t -O 1 a < two; echo "${a[*]} ${#a[2]}"',
    "x café ţară 4\n",
  ],
  [
    'mapfile -d "" -t a < nul; echo "${a[0]} ${#a[0]} ${a[1]} ${#a[1]}"',
    "éa 2 ţb 2\n",
  ],
  ['mapfile -d é -t a < f; echo "${#a[@]}"', "2\n"],
  ['mapfile -t a <<< "ţară"; echo "${a[0]} ${#a[0]}"', "ţară 4\n"],
  ['mapfile -d ab -t a <<< "xxbyyazz"; echo "${a[0]}"', "xxbyy\n"],
];

describe("read and mapfile over UTF-8", () => {
  for (const [script, want] of cases) {
    test(script, async () => {
      const result = await new Bash().exec(setup + script);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(want);
    });
  }

  test("a read loop copies a file byte for byte", async () => {
    const text = "café\nţară ăîș\n😀 emoji\n\tindented  \nlast";
    const bash = new Bash({ files: { "/in": text } });
    const result = await bash.exec(
      'while IFS= read -r l || [ -n "$l" ]; do printf \'%s\\n\' "$l"; done < /in > /out',
    );
    expect(result.exitCode).toBe(0);
    const out = await bash.fs.readFileBuffer("/out");
    expect(Buffer.from(out).toString("utf8")).toBe(`${text}\n`);
  });

  test("mapfile copies a file byte for byte", async () => {
    const text = "café\nţară ăîș\n😀 emoji\n";
    const bash = new Bash({ files: { "/in": text } });
    await bash.exec("mapfile a < /in; printf '%s' \"${a[@]}\" > /out");
    const out = await bash.fs.readFileBuffer("/out");
    expect(Buffer.from(out).toString("utf8")).toBe(text);
  });

  test("bytes that are not UTF-8 stay one character each", async () => {
    // bash keeps the raw byte; a variable here holds it as U+00E9.
    const fs = new InMemoryFs({
      "/bad": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]),
    });
    const result = await new Bash({ fs }).exec(
      'read l < /bad; echo ${#l}; read -n 4 m < /bad; echo ${#m}; { read -N 4 n; read o; } < /bad; echo "${#n}[$o]"; mapfile -t a < /bad; echo "${#a[0]} ${a[1]}"',
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("4\n4\n4[]\n4 x\n");
  });
});
