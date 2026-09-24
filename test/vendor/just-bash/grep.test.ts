// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the recorded GNU grep fixture cannot pin: the words of an error,
// which the fixture does not compare, and GNU's version text, which the
// recorded binary gives under another name.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

async function run(command: string, files: Record<string, string> = {}) {
  const bash = new Bash({ files, cwd: "/work" });
  return bash.exec(command);
}

describe("grep's words", () => {
  test("a pattern from a file names the file and line", async () => {
    const result = await run("grep -f pats hay", {
      "/work/pats": "ok\n[a\n",
      "/work/hay": "ok\n",
    });
    expect(result.stderr).toBe(
      "grep: pats:2: Unmatched [, [^, [:, [., or [=\n",
    );
    expect(result.exitCode).toBe(2);
  });

  test("a pattern from the command line does not", async () => {
    const result = await run("grep -e ok -e 'a\\{1' hay", {
      "/work/hay": "ok\n",
    });
    expect(result.stderr).toBe("grep: Unmatched \\{\n");
    expect(result.exitCode).toBe(2);
  });

  test("a backreference is refused naming it", async () => {
    const result = await run("grep '\\(ab\\)\\1' hay", {
      "/work/hay": "abab\n",
    });
    expect(result.stderr).toContain("backreference \\1 is not supported");
    expect(result.exitCode).toBe(2);
  });

  test("a stray backslash warns and still matches", async () => {
    const result = await run("grep 'a\\-b' hay", { "/work/hay": "a-b\n" });
    expect(result.stdout).toBe("a-b\n");
    expect(result.stderr).toBe("grep: warning: stray \\ before -\n");
    expect(result.exitCode).toBe(0);
  });

  test("an unknown option shows GNU's usage and exits 2", async () => {
    const result = await run("grep --frobnicate x hay", { "/work/hay": "x\n" });
    expect(result.stderr).toBe(
      "grep: unrecognized option '--frobnicate'\n" +
        "Usage: grep [OPTION]... PATTERNS [FILE]...\n" +
        "Try 'grep --help' for more information.\n",
    );
    expect(result.exitCode).toBe(2);
  });
});
