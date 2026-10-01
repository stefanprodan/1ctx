// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// re2js 1.4.0 throws a TypeError for most Unicode classes under case
// folding; UserRegex reports it as the syntax error it gives any pattern
// RE2 refuses, so the commands print their invalid-pattern message.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import { createUserRegex } from "../../../vendor/just-bash/src/regex/user-regex.ts";

const refused =
  "error parsing regexp: Unicode class not supported with case folding";

describe("a Unicode class under case folding", () => {
  for (const [pattern, flags] of [
    ["\\pN", "i"],
    ["\\p{N}", "i"],
    ["(?i)\\PN", ""],
    ["(?i)[\\pL\\PN]", ""],
  ]) {
    test(`/${pattern}/${flags} is a syntax error`, () => {
      expect(() => createUserRegex(pattern, flags)).toThrow(SyntaxError);
      expect(() => createUserRegex(pattern, flags)).toThrow(
        `Invalid regular expression: /${pattern}/: ${refused}`,
      );
    });
  }

  test("classes with a fold table still compile", () => {
    expect(createUserRegex("\\pL\\PL", "i").test("1a")).toBe(false);
    expect(createUserRegex("\\pL\\PL", "i").test("A1")).toBe(true);
    expect(createUserRegex("\\pL", "i").test("A")).toBe(true);
    expect(createUserRegex("\\pN").test("a1")).toBe(true);
  });

  test("jq and yq print it as an invalid pattern", async () => {
    const bash = new Bash();
    const jq = await bash.exec(`jq -n '"a1" | match("\\\\p{N}"; "i")'`);
    expect(jq.stderr).toBe(
      `jq: parse error: Invalid regular expression: /\\p{N}/: ${refused}\n`,
    );
    expect(jq.exitCode).toBe(5);
    const yq = await bash.exec(`yq -n '"a1" | sub("(?i)\\\\pN"; "x")'`);
    expect(yq.stderr).toBe(
      `yq: parse error: Invalid regular expression: /(?i)\\pN/: ${refused}\n`,
    );
    expect(yq.exitCode).toBe(1);
  });
});
