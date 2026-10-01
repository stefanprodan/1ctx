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
  [
    String.raw`find src -path 'src/v\endor/*'`,
    "src/vendor/x\nsrc/vendor/x/a.ts\n",
  ],
  [
    String.raw`find src -ipath 'SRC/V\ENDOR/*'`,
    "src/vendor/x\nsrc/vendor/x/a.ts\n",
  ],
  [
    String.raw`find src -path 'src/v\endor/*' -size -100k`,
    "src/vendor/x\nsrc/vendor/x/a.ts\n",
  ],
  [
    String.raw`find src -ipath 'SRC/V\ENDOR/*' -size -100k`,
    "src/vendor/x\nsrc/vendor/x/a.ts\n",
  ],
  [
    String.raw`find src -path 'src/v\endor' -prune -o -type f -print`,
    "src/c.ts\nsrc/lib/b.ts\n",
  ],
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

  const escaped: [string, string][] = [
    [String.raw`src/a\*b/*`, "src/a*b/file\n"],
    [String.raw`src/a\?b/*`, "src/a?b/file\n"],
    [String.raw`src/a\[b/*`, "src/a[b/file\n"],
    [String.raw`src/a\\b/*`, "src/a\\b/file\n"],
    [String.raw`src/n\ew?line/*`, "src/new\nline/file\n"],
    ["src/trailing\\", ""],
    [String.raw`src/trailing\\`, "src/trailing\\\n"],
  ];
  for (const [pattern, stdout] of escaped) {
    for (const suffix of ["", " -size -100k"]) {
      test(`escaped path ${JSON.stringify(pattern)}${suffix}`, async () => {
        const names = ["a*b", "a?b", "a[b", "a\\b", "new\nline", "trailing\\"];
        const bash = new Bash({
          cwd: "/w",
          files: Object.fromEntries(
            names.map((name) => [`/w/src/${name}/file`, ""]),
          ),
        });
        const result = await bash.exec(`find src -path '${pattern}'${suffix}`);
        expect(result.stdout).toBe(stdout);
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      });
    }
  }
});
