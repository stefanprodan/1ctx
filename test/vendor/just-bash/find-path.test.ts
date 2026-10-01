// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// find -path and -ipath from a relative starting point with no `./`, as
// GNU findutils 4.11 find answered the same tree.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

// src/c.ts, src/lib/b.ts, src/vendor/x/a.ts
async function run(script: string) {
  const bash = new Bash({ cwd: "/w" });
  await bash.exec(
    "mkdir -p /w/src/vendor/x /w/src/lib; touch /w/src/vendor/x/a.ts /w/src/lib/b.ts /w/src/c.ts",
  );
  return bash.exec(script);
}

const cases: [string, string][] = [
  [
    "find src -path src/vendor -prune -o -type f -print",
    "src/c.ts\nsrc/lib/b.ts\n",
  ],
  ["find src -path 'src/lib/*'", "src/lib/b.ts\n"],
  ["find src -ipath 'SRC/LIB/*'", "src/lib/b.ts\n"],
  ["find src -path 'src/lib/*' -size -1k", "src/lib/b.ts\n"],
  ["find src -path src", "src\n"],
  ["find src -path 'src/*/x'", "src/vendor/x\n"],
];

describe("find -path", () => {
  for (const [script, stdout] of cases) {
    test(script, async () => {
      const result = await run(script);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(stdout);
      expect(result.exitCode).toBe(0);
    });
  }
});
