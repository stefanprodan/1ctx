// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What our awk does that gawk cannot answer for us: our limits, an
// abort, and where we refuse rather than copy gawk.

import { describe, expect, test } from "bun:test";
import { Bash, defineCommand } from "just-bash";

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

  test("an abort stops the read under a regex RS at the next record", async () => {
    const controller = new AbortController();
    // a command the program runs through getline aborts the shell
    const trip = defineCommand("trip", async () => {
      controller.abort();
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const bash = new Bash({
      files: { "/w/big.txt": "ab--".repeat(1000) },
      customCommands: [trip],
    });
    const r = await bash.exec(
      `awk 'BEGIN { RS = "-+" } NR == 3 { "trip" | getline } { n++ } END { print "done", n }' /w/big.txt`,
      { signal: controller.signal },
    );
    expect(r.stdout).not.toContain("done");
    expect(r.exitCode).not.toBe(0);
  });

  test("a field past the element cap is refused", async () => {
    const bash = new Bash({ executionLimits: { maxArrayElements: 10 } });
    const assign = await bash.exec(`awk '{ $11 = "x"; print NF }'`, {
      stdin: "a\n",
    });
    expect(assign.stdout).toBe("");
    expect(assign.stderr).toBe("awk: field limit exceeded (10)\n");
    expect(assign.exitCode).toBe(LIMIT_EXIT);
    const nf = await bash.exec(`awk '{ NF = 11; print NF }'`, {
      stdin: "a\n",
    });
    expect(nf.stderr).toBe("awk: field limit exceeded (10)\n");
    expect(nf.exitCode).toBe(LIMIT_EXIT);
    const under = await bash.exec(`awk '{ $10 = "x"; print NF }'`, {
      stdin: "a\n",
    });
    expect(under.stdout).toBe("10\n");
  });

  test("ARGV and ENVIRON count against the element cap", async () => {
    const bash = new Bash({
      env: {},
      executionLimits: { maxArrayElements: 6 },
    });
    const r = await bash.exec(
      `awk 'BEGIN { n = split("a b c d e f", ARGV); print n }'`,
    );
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("awk: array element limit exceeded (6)\n");
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  test("print to /dev/stderr reaches stderr", async () => {
    const r = await new Bash().exec(
      `awk '{ print "e" $0 > "/dev/stderr"; print "o" $0 }'`,
      { stdin: "1\n2\n" },
    );
    expect(r.stdout).toBe("o1\no2\n");
    expect(r.stderr).toBe("e1\ne2\n");
    expect(r.exitCode).toBe(0);
  });
});

describe("gawk features we do not have", () => {
  const refused: [string, string][] = [
    ["BEGINFILE", "BEGINFILE { print FILENAME }"],
    ["ENDFILE", "ENDFILE { print FILENAME }"],
    ["PROCINFO", 'BEGIN { PROCINFO["sorted_in"] = "@ind_str_asc" }'],
    ["@include", '@include "lib.awk"'],
    ["@load", '@load "ordchr"'],
    ["@namespace", '@namespace "ns"'],
    ["IGNORECASE", "{ IGNORECASE = 1 }"],
    ["FPAT", 'BEGIN { FPAT = "[^,]+" }'],
    ["FIELDWIDTHS", 'END { FIELDWIDTHS = "2 2" }'],
  ];
  for (const [name, construct] of refused) {
    test(`${name} is refused before anything runs`, async () => {
      const program = `BEGIN { print "ran" }\n${construct}`;
      const r = await new Bash().exec(`awk '${program}'`, { stdin: "a\n" });
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`awk: ${name} is not supported\n`);
      expect(r.exitCode).toBe(2);
    });
  }

  test("a refused variable given by -v is refused", async () => {
    const r = await new Bash().exec(`awk -v IGNORECASE=1 '{ print }'`, {
      stdin: "a\n",
    });
    expect(r.stderr).toBe("awk: IGNORECASE is not supported\n");
    expect(r.exitCode).toBe(2);
  });

  for (const call of [
    'strtonum("0x1A")',
    "asort(a)",
    "asorti(a)",
    'patsplit("a b", a)',
    "isarray(a)",
    "typeof(a)",
  ]) {
    const name = call.slice(0, call.indexOf("("));
    test(`${name} is a function not defined`, async () => {
      const r = await new Bash().exec(
        `awk 'BEGIN { print "before"; x = ${call} }'`,
      );
      expect(r.stdout).toBe("before\n");
      expect(r.stderr).toBe(`awk: function '${name}' not defined\n`);
      expect(r.exitCode).toBe(2);
    });
  }

  for (const call of [
    "systime()",
    'mktime("2026 01 01 00 00 00")',
    "strftime()",
  ]) {
    const name = call.slice(0, call.indexOf("("));
    test(`a valid call to ${name} reaches its runtime error`, async () => {
      const r = await new Bash().exec(
        `awk 'BEGIN { print "before"; x = ${call} }'`,
      );
      expect(r.stdout).toBe("before\n");
      expect(r.stderr).toBe(`awk: function '${name}()' is not implemented\n`);
      expect(r.exitCode).toBe(2);
    });
  }
});
