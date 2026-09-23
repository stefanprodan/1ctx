// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What our awk does that gawk cannot answer for us: our limits, an
// abort, and where we refuse rather than copy gawk.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

const LIMIT_EXIT = 126;

describe("awk limits and refusals", () => {
  test("the main input and every getline file share one byte budget", async () => {
    const bash = new Bash({
      files: {
        "/w/in.txt": "main-line\n",
        "/w/g1.txt": "first-get\n",
        "/w/g2.txt": "second-gt\n",
      },
      cwd: "/w",
      executionLimits: { maxInputBytes: 25 },
    });
    const r = await bash.exec(
      `awk '{ getline a < "g1.txt"; print a; getline b < "g2.txt"; print b }' in.txt`,
    );
    expect(r.stdout).toBe("first-get\n");
    expect(r.stderr).toBe(
      "awk: aggregate input size limit exceeded (25 bytes)\n",
    );
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  test("a command's output counts against the same budget", async () => {
    const bash = new Bash({
      files: { "/w/in.txt": "0123456789\n" },
      cwd: "/w",
      executionLimits: { maxInputBytes: 15 },
    });
    const r = await bash.exec(
      `awk '{ "echo 0123456789" | getline x; print x }' in.txt`,
    );
    expect(r.stderr).toBe(
      "awk: aggregate input size limit exceeded (15 bytes)\n",
    );
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  test("records are counted as they are read", async () => {
    const bash = new Bash({
      files: { "/r": "a\nb\nc\n" },
      executionLimits: { maxArrayElements: 2 },
    });
    const r = await bash.exec(`awk '{ print }' /r`);
    expect(r.stdout).toBe("a\nb\n");
    expect(r.stderr).toBe("awk: record array limit exceeded (2)\n");
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  test("match raises the element cap error rather than failing the match", async () => {
    const bash = new Bash({ executionLimits: { maxArrayElements: 5 } });
    const r = await bash.exec(
      `awk 'BEGIN { print match("abc", /(a)(b)(c)/, m) }'`,
    );
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("awk: array element limit exceeded (5)\n");
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  test("an RS that matches the empty string is refused", async () => {
    const r = await new Bash().exec(
      `printf 'XaX' | awk 'BEGIN { RS = "X*"; print "begin" } { print "[" $0 "]" }'`,
    );
    expect(r.stdout).toBe("begin\n");
    expect(r.stderr).toBe("awk: RS matches the empty string\n");
    expect(r.exitCode).toBe(2);
  });

  test("an abort stops a long read under a regex RS", async () => {
    const records = 300_000;
    const bash = new Bash({ files: { "/w/big.txt": "ab--".repeat(records) } });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const r = await bash.exec(
      `awk 'BEGIN { RS = "-+" } { n++ } END { print "done", n }' /w/big.txt`,
      { signal: controller.signal },
    );
    expect(r.stdout).not.toContain("done");
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
