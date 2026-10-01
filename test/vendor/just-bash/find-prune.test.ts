// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// GNU findutils 4.11 evaluates the left side of -o before its right-hand
// -prune, even when the left side needs a directory read or file metadata.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

describe("find early prune", () => {
  const cases: [string, string][] = [
    ["find t -empty -print -o -name e -prune", "t/e\n"],
    ["find t -empty -o -name e -prune", "t/e\n"],
    ["find t -size -100k -o -name d -prune", "t\nt/d\nt/d/file\nt/e\n"],
    [
      "find t \\( -type d -o -empty \\) -o -name d -prune -o -print",
      "t/d/file\n",
    ],
    ["find t -name d -prune -o -empty -print", "t/e\n"],
  ];
  for (const [script, stdout] of cases) {
    test(script, async () => {
      const bash = new Bash({ cwd: "/" });
      await bash.exec("mkdir -p t/e t/d; echo content > t/d/file");
      const result = await bash.exec(script);
      expect(result.stdout).toBe(stdout);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});
