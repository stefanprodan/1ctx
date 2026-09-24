// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The search engine grep and rg share. grep's answers are pinned by the
// recorded GNU grep fixture; these pin what the engine's fixes change in
// rg, each answer checked against ripgrep 15.2.0 with -N -s so that our
// rg's own defaults do not enter, and a read error that is not a missing
// file.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import {
  buildRegex,
  searchContent,
} from "../../../vendor/just-bash/src/commands/search-engine/index.ts";

const files = {
  "/work/a.txt": "foo one\nfoo two\nbar\nbaz\nfoo three\n",
  "/work/u.txt": "café au lait\nid=42 x\n\nx  y\n",
  "/work/m.txt": "m\nm\nx\n",
  "/work/o.txt": "foo\n",
  "/work/e.txt": "é foo\n",
};

async function run(command: string) {
  const bash = new Bash({ files, cwd: "/work" });
  return bash.exec(command);
}

describe("the search engine, as ripgrep answers", () => {
  const cases: [string, string, number][] = [
    ["rg -N -s -A1 foo a.txt", "foo one\nfoo two\nbar\n--\nfoo three\n", 0],
    [
      "rg -n -s -A1 foo a.txt",
      "1:foo one\n2:foo two\n3-bar\n--\n5:foo three\n",
      0,
    ],
    ["rg -N -s -o -A1 m m.txt", "m\nm\nx\n", 0],
    ["rg -N -s -o 'x*' o.txt", "\n\n\n\n", 0],
    ["rg -N -s -r X 'o*' o.txt", "XfX\n", 0],
    ["rg -N -s -m1 -c foo a.txt", "1\n", 0],
    ["rg -N -s -m1 --count-matches o a.txt", "3\n", 0],
    ["rg -N -s -m0 foo a.txt", "", 1],
    ["rg -N -s -c -o o a.txt", "8\n", 0],
    ["rg -N -s -b foo e.txt", "0:é foo\n", 0],
    ["rg -N -s -bo foo e.txt", "3:foo\n", 0],
    ["rg -s --column foo e.txt", "1:4:é foo\n", 0],
    ["rg -N -s -w café u.txt", "café au lait\n", 0],
    ["rg -N -s -w =42 u.txt", "", 1],
    ["rg -N -s -w '' u.txt", "\nx  y\n", 0],
    ["rg -N -s '(?i)FOO' a.txt", "foo one\nfoo two\nfoo three\n", 0],
    ["rg -N -s '(?x) f o o' o.txt", "foo\n", 0],
  ];
  for (const [command, stdout, exitCode] of cases) {
    test(command, async () => {
      const result = await run(command);
      expect(result.stdout).toBe(stdout);
      expect(result.exitCode).toBe(exitCode);
    });
  }
});

describe("the search engine's errors", () => {
  test("a read that fails for another reason says so", async () => {
    class FailingFs extends InMemoryFs {
      override async readFile(path: string, options?: unknown) {
        if (path.endsWith("/broken.txt")) {
          throw new Error("EIO: input/output error, read");
        }
        return super.readFile(path, options as never);
      }
    }
    const fs = new FailingFs({ "/work/broken.txt": "foo\n" }, {});
    const bash = new Bash({ fs, cwd: "/work" });
    const result = await bash.exec("grep foo broken.txt");
    expect(result.stderr).toBe(
      "grep: broken.txt: EIO: input/output error, read\n",
    );
    expect(result.exitCode).toBe(2);
  });
});

describe("the -w retries", () => {
  test("pay toward the work limit on a line built to make them cubic", () => {
    // each shorter match again ends before a word character
    const line = `a${" ab".repeat(200)}\n`;
    const { regex } = buildRegex("a[ ab]*a", { mode: "basic" });
    expect(() =>
      searchContent(line, regex, { wholeWord: true, maxWork: 50_000 }),
    ).toThrow("matching work limit exceeded");
    expect(
      searchContent("a ab ab!\n", regex, { wholeWord: true, countOnly: true })
        .output,
    ).toBe("0\n");
  });
});
