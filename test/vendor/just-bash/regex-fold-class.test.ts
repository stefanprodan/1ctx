// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A Unicode class under case folding matches as the class itself when
// RE2 has no fold table for it, as ripgrep 15.2.0, GNU grep 3.12 -P,
// jq 1.8.2 and mikefarah's yq 4.53.3 answered. re2js 1.4.0 threw a
// TypeError for these until patches/re2js@1.4.0.patch.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

const lines = ["a", "A", "1", "١", "k", "K", "κ", "Κ", "漢", "é", "É", "-"];
const numbers = ["1", "١"];
const latin = ["a", "A", "k", "K", "é", "É"];
const letters = ["a", "A", "k", "K", "κ", "Κ", "漢", "é", "É"];
const others = lines.filter((line) => !numbers.includes(line));
const greek = ["κk", "κK", "Κk", "ak"];

// each class anchored to a whole line, with what the tools printed
const cases: [string, string[]][] = [
  [String.raw`\pN`, numbers],
  [String.raw`\PN`, others],
  [String.raw`\p{Latin}`, latin],
  [String.raw`\P{Latin}`, lines.filter((line) => !latin.includes(line))],
  [String.raw`\p{Han}`, ["漢"]],
  [String.raw`[\pL\PN]`, others],
  // a class with a fold table, which matched before the patch too
  [String.raw`\pL`, letters],
];

// jq's Oniguruma takes a one-letter class only in braces
const braced = (pattern: string) =>
  pattern.replace(/\\([pP])(\w)\b/g, "\\$1{$2}");

const bash = () =>
  new Bash({
    files: {
      "/f": `${lines.join("\n")}\n`,
      "/g": `${greek.join("\n")}\n`,
    },
  });
const printed = (stdout: string) => stdout.split("\n").filter(Boolean);

describe("a Unicode class under case folding", () => {
  for (const [pattern, expected] of cases) {
    test(`rg -i and grep -iP: ${pattern}`, async () => {
      const shell = bash();
      const rg = await shell.exec(`rg -iN '^${pattern}$' /f`);
      expect(printed(rg.stdout)).toEqual(expected);
      expect(rg.exitCode).toBe(0);
      const grep = await shell.exec(`grep -iP '^${pattern}$' /f`);
      expect(printed(grep.stdout)).toEqual(expected);
      expect(grep.exitCode).toBe(0);
    });

    test(`jq test with "i" and yq test with (?i): ${pattern}`, async () => {
      const shell = bash();
      const jq = await shell.exec(
        `jq -R -r 'select(test(${JSON.stringify(`^${braced(pattern)}$`)}; "i"))' /f`,
      );
      expect(printed(jq.stdout)).toEqual(expected);
      const yq = await shell.exec(
        `yq -n -o json -I0 '${JSON.stringify(lines)} | map(select(test(${JSON.stringify(`(?i)^${pattern}$`)})))'`,
      );
      expect(JSON.parse(yq.stdout)).toEqual(expected);
    });
  }

  test("a script class joined to a folded letter", async () => {
    const shell = bash();
    const expected = ["κk", "κK", "Κk"];
    const rg = await shell.exec(String.raw`rg -iN '^\p{Greek}k$' /g`);
    expect(printed(rg.stdout)).toEqual(expected);
    const jq = await shell.exec(
      String.raw`jq -R -r 'select(test("^\\p{Greek}k$"; "i"))' /g`,
    );
    expect(printed(jq.stdout)).toEqual(expected);
  });

  test("jq match and sub, yq sub", async () => {
    const shell = bash();
    const jq = await shell.exec(
      String.raw`jq -n -c '"a1" | [match("\\p{N}"; "gi").string], sub("\\p{N}"; "x"; "i")'`,
    );
    expect(jq).toMatchObject({ stdout: '["1"]\n"ax"\n', exitCode: 0 });
    // Bun escapes a raw template's non-ASCII, so this one is cooked
    const yq = await shell.exec(`yq -n '"a1Ⅻ" | sub("(?i)\\\\pN"; "x")'`);
    expect(yq).toMatchObject({ stdout: "axx\n", exitCode: 0 });
  });
});
