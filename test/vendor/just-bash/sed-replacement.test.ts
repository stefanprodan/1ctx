// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An escaped backslash in a sed replacement is one literal backslash:
// the stdout and exit code GNU sed 4.10 answered for the same scripts.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

// [script, stdout]
const cases: [string, string][] = [
  // Upstream's own cases for the fix.
  [String.raw`echo x | sed 's/\(x\)/\\\1/'`, "\\x\n"],
  [
    "printf '%s\\n' 'a\\(b$c\"d' | sed 's/\\([\"`$\\\\]\\)/\\\\\\1/g'",
    'a\\\\(b\\$c\\"d\n',
  ],
  [String.raw`echo x | sed 's/x/\\&/'`, "\\x\n"],
  [String.raw`echo a/b | sed 's,/,\\,'`, "a\\b\n"],
  // An escaped backslash before a letter, a digit, & or the delimiter.
  [String.raw`echo ab | sed 's/a/\\n/'`, "\\nb\n"],
  [String.raw`echo ab | sed 's/a/x\\y/'`, "x\\yb\n"],
  [String.raw`echo ab | sed 's/\(a\)/\\\1/'`, "\\ab\n"],
  [String.raw`echo ab | sed 's/a/\\&/'`, "\\ab\n"],
  [String.raw`echo ab | sed 's,a,\\,'`, "\\b\n"],
  [String.raw`printf 'a\nb\n' | sed 'N;s/\n/\\n/'`, "a\\nb\n"],
  // The single escapes keep their meaning.
  [String.raw`echo ab | sed 's/a/\n/'`, "\nb\n"],
  [String.raw`echo ab | sed 's/a/\t/'`, "\tb\n"],
  [String.raw`echo ab | sed 's/a/\q/'`, "qb\n"],
];

describe("sed replacement backslashes", () => {
  for (const [script, stdout] of cases) {
    test(script, async () => {
      const r = await new Bash().exec(script);
      expect({ stdout: r.stdout, exitCode: r.exitCode }).toEqual({
        stdout,
        exitCode: 0,
      });
    });
  }
});
