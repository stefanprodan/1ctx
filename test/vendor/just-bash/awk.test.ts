// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What our awk does that gawk cannot answer for us: our limits, an
// abort, and where we refuse rather than copy gawk.

import { describe, expect, test } from "bun:test";
import { Bash, defineCommand, InMemoryFs } from "just-bash";

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

  test("gawk is a name of awk, and both say they are gawk", async () => {
    const bash = new Bash();
    const names = await bash.exec("command -v gawk; which gawk; type gawk");
    expect(names.stdout).toBe(
      "/usr/bin/gawk\n/usr/bin/gawk\ngawk is /usr/bin/gawk\n",
    );
    const run = await bash.exec(`printf 'a b\\n' | gawk '{ print $2 }'`);
    expect(run.stdout).toBe("b\n");
    for (const command of [
      "awk --version",
      "gawk -V",
      "awk -v x=1 --version",
    ]) {
      const r = await bash.exec(command);
      expect(r.stdout.split("\n")[0]).toBe(
        "GNU Awk 5.4.1 (just-bash, compatible)",
      );
      expect(r.exitCode).toBe(0);
    }
  });

  test("pipes closed at the end run in the order opened", async () => {
    const r = await new Bash().exec(
      `awk 'BEGIN { print "1" | "cat"; print "2" | "cat -n"; print "3" | "cat"; print "own" }'`,
    );
    expect(r.stdout).toBe("1\n3\n     1\t2\nown\n");
    expect(r.exitCode).toBe(0);
  });

  test("a pipe's text counts against the output cap", async () => {
    const bash = new Bash({ executionLimits: { maxOutputSize: 12 } });
    const r = await bash.exec(
      `awk 'BEGIN { print "12345"; print "678901" | "cat"; print "x" | "cat" }'`,
    );
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("output size");
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  test("open pipes are capped", async () => {
    const r = await new Bash().exec(
      `awk 'BEGIN { for (i = 1; i <= 17; i++) print i | ("cat # " i) }'`,
    );
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("awk: output pipe limit exceeded (16)\n");
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  test("an abort stops the pipes before their commands run", async () => {
    const controller = new AbortController();
    const trip = defineCommand("trip", async () => {
      controller.abort();
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const bash = new Bash({ customCommands: [trip] });
    const r = await bash.exec(
      `awk 'BEGIN { print "a" | "cat"; close("trip"); "trip" | getline; print "b" | "cat" }'`,
      { signal: controller.signal },
    );
    expect(r.stdout).not.toContain("a");
    expect(r.exitCode).not.toBe(0);
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

describe("awk output files and speed", () => {
  async function run(
    command: string,
    files: Record<string, string> = {},
    options: ConstructorParameters<typeof Bash>[0] = {},
  ) {
    const bash = new Bash({ files, cwd: "/w", ...options });
    const r = await bash.exec(command);
    const read = (path: string) => bash.readFile(path).catch(() => null);
    return { ...r, read };
  }

  test("> truncates once, >> appends, close() lets > truncate again", async () => {
    const r = await run(
      `awk 'BEGIN { print "a" > "t"; print "b" > "t"; print "c" >> "p"; print "d" >> "p"; print "e" > "c"; close("c"); print "f" > "c" }'`,
      { "/w/t": "old\n", "/w/p": "old\n" },
    );
    expect([r.stdout, r.stderr, r.exitCode]).toEqual(["", "", 0]);
    expect(await r.read("/w/t")).toBe("a\nb\n");
    expect(await r.read("/w/p")).toBe("old\nc\nd\n");
    expect(await r.read("/w/c")).toBe("f\n");
  });

  test("a command, a getline and an operand see what was written", async () => {
    const r = await run(
      `awk 'BEGIN { print "a" > "out"; print "b" > "out"; "cat out" | getline x; print x; print "c" > "out"; print "d" | "wc -l < out"; close("wc -l < out"); while ((getline y < "out") > 0) print "g:" y; print "e" > "out" } { print "r:" $0 }' out`,
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("a\n3\ng:a\ng:b\ng:c\nr:a\nr:b\nr:c\nr:e\n");
  });

  test("an abort keeps what was written before it", async () => {
    const controller = new AbortController();
    const trip = defineCommand("trip", async () => {
      controller.abort();
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const bash = new Bash({ cwd: "/w", customCommands: [trip] });
    const r = await bash.exec(
      `awk 'BEGIN { print "a" > "out"; print "b" > "out"; "trip" | getline; print "c" > "out" }'`,
      { signal: controller.signal },
    );
    expect(r.exitCode).not.toBe(0);
    expect(await bash.readFile("/w/out")).toBe("a\nb\n");
  });

  test("a limit still writes what the files held", async () => {
    const r = await run(
      `seq 1 5 | awk '{ print > "out" }'`,
      {},
      { executionLimits: { maxAwkIterations: 3 } },
    );
    expect(r.stderr).toBe("awk: record limit exceeded (3)\n");
    expect(r.exitCode).toBe(LIMIT_EXIT);
    expect(await r.read("/w/out")).toBe("1\n2\n3\n");
  });

  test("printf's width limit counts the output in bytes", async () => {
    const r = await run(
      `awk '{ printf "%s", $0; printf "%50s", "x" > "out" }' hay`,
      { "/w/hay": "é".repeat(40) },
      { executionLimits: { maxStringLength: 100, maxOutputSize: 10_000 } },
    );
    expect(r.stderr).toBe("awk: printf width limit exceeded (20 bytes)\n");
    expect(r.exitCode).toBe(LIMIT_EXIT);
  });

  // a shell whose filesystem has room for 20 bytes more than it starts with
  function tight() {
    const probe = new InMemoryFs({}, {});
    new Bash({ fs: probe, cwd: "/w" });
    const base = (probe as unknown as { retainedBytes: number }).retainedBytes;
    const fs = new InMemoryFs({}, { maxTotalBytes: base + 20 });
    return new Bash({ fs, cwd: "/w" });
  }

  test("a failed write leaves the other files and the pipes whole", async () => {
    const bash = tight();
    const r = await bash.exec(
      `awk 'BEGIN { print "pipe" | "cat"; print "a" > "bad"; print "b" > "good"; print "c" > "good"; print "12345678901234567890" > "bad" }'`,
    );
    expect(r.stdout).toBe("pipe\n");
    expect(r.stderr).toContain("ENOSPC");
    expect(r.exitCode).toBe(2);
    expect(await bash.readFile("/w/good")).toBe("b\nc\n");
    expect(await bash.readFile("/w/bad")).toBe("a\n");
  });

  test("a failed write before close() still runs that pipe", async () => {
    const bash = tight();
    const r = await bash.exec(
      `awk 'BEGIN { print "pipe" | "cat"; print "a" > "bad"; print "123456789012345678901234567890" > "bad"; close("cat") }'`,
    );
    expect(r.stdout).toBe("pipe\n");
    expect(r.stderr).toContain("ENOSPC");
    expect(r.exitCode).toBe(2);
  });

  test("an append that does not fit fails rather than replacing the file", async () => {
    const bash = tight();
    const r = await bash.exec(
      `awk 'BEGIN { printf "aaaaaaaaaa" > "out"; printf "bbbbbb" > "out"; printf "cccccc" > "out" }'`,
    );
    expect(r.stderr).toContain("ENOSPC");
    expect(r.exitCode).toBe(2);
    expect(await bash.readFile("/w/out")).toBe("aaaaaaaaaa");
  });

  test(">> to a directory is fatal, as gawk", async () => {
    const r = await run(`awk 'BEGIN { print "x" >> "d"; print "after" }'`, {
      "/w/d/x": "",
    });
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("EISDIR");
    expect(r.exitCode).toBe(2);
  });

  test("the bytes written are kept, a BOM included, as gawk", async () => {
    const bash = new Bash({ cwd: "/w" });
    await bash.exec(
      `awk 'BEGIN { printf "%c", 65279 > "out"; printf "%c", 65279 > "out"; printf "x" > "out" }'`,
    );
    const bytes = await bash.fs.readFileBuffer("/w/out");
    expect(Buffer.from(bytes).toString("hex")).toBe("efbbbfefbbbf78");
  });

  test("a file opened through a link sees what the other name held", async () => {
    const r = await run(
      `ln -s out alias; awk 'BEGIN { print "a" > "out"; print "b" > "out"; print "c" >> "alias"; close("out"); close("alias") }'; cat alias out`,
    );
    expect([r.stdout, r.stderr, r.exitCode]).toEqual([
      "a\nb\nc\na\nb\n",
      "",
      0,
    ]);
  });

  test("halves of a surrogate pair stay apart in a file and join in stdout", async () => {
    const file = await run(
      `awk 'BEGIN { printf "x" > "out"; printf "%s", "\uD83D" > "out"; printf "%s", "\uDE00" > "out" }'`,
    );
    expect([file.stdout, file.stderr, file.exitCode]).toEqual(["", "", 0]);
    expect(await file.read("/w/out")).toBe("x\uFFFD\uFFFD");
    const out = await run(
      `awk 'BEGIN { ORS = ""; print "\uD83D"; print "\uDE00"; printf "%95s", "x" > "out" }'`,
      {},
      { executionLimits: { maxStringLength: 100, maxOutputSize: 10_000 } },
    );
    expect([out.stdout, out.stderr, out.exitCode]).toEqual(["😀", "", 0]);
    expect(await out.read("/w/out")).toBe(`${" ".repeat(94)}x`);
  });

  // Runners differ in speed, so these compare a run against one a
  // quarter its size: linear work grows about 4 times, the quadratic bugs
  // grew 16.
  const timed = async (bash: Bash, command: string) => {
    const started = performance.now();
    const result = await bash.exec(command);
    return [performance.now() - started, result] as const;
  };

  test("10k files open in linear time", async () => {
    const files = (n: number) =>
      `seq 1 ${n} | awk '{ print > ($1 ".txt"); print "again" > ($1 ".txt") }'`;
    await new Bash({ cwd: "/w" }).exec(files(2_500));
    const [quarter] = await timed(new Bash({ cwd: "/w" }), files(2_500));
    const bash = new Bash({ cwd: "/w" });
    const [full, r] = await timed(bash, files(10_000));
    // a flush that walked every open file grew with their square
    expect(full / quarter).toBeLessThan(8);
    expect([r.stdout, r.stderr, r.exitCode]).toEqual(["", "", 0]);
    expect(await bash.readFile("/w/9999.txt")).toBe("9999\nagain\n");
  });

  test("printf and print > f at 20k lines stay linear", async () => {
    const shell = () =>
      new Bash({ cwd: "/w", executionLimits: { maxOutputSize: 10_000_000 } });
    const printf = (n: number) =>
      `seq 1 ${n} | awk '{ printf "pod-%d ns-%d\\n", $1, $1 % 23 }'`;
    const print = (n: number) =>
      `seq 1 ${n} | awk '{ print "pod-" $1 > "out" }'`;
    const both = async (bash: Bash, n: number) => {
      const [a, out] = await timed(bash, printf(n));
      const [b, file] = await timed(bash, print(n));
      return [a + b, out, file] as const;
    };
    await both(shell(), 5_000);
    const [quarter] = await both(shell(), 5_000);
    const bash = shell();
    const [full, out, file] = await both(bash, 20_000);
    // quadratic, the time grew with the square of the lines
    expect(full / quarter).toBeLessThan(8);
    const lines = Array.from(
      { length: 20_000 },
      (_, i) => `pod-${i + 1} ns-${(i + 1) % 23}\n`,
    );
    expect([out.stdout, out.stderr, out.exitCode]).toEqual([
      lines.join(""),
      "",
      0,
    ]);
    expect([file.stdout, file.stderr, file.exitCode]).toEqual(["", "", 0]);
    expect((await bash.readFile("/w/out")).split("\n")).toHaveLength(20_001);
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

  test("a user comparison function for asort is refused", async () => {
    const r = await new Bash().exec(
      `awk 'function cmp(i1, v1, i2, v2) {return v2 - v1} BEGIN { print "before"; a[1] = 1; n = asort(a, d, "cmp") }'`,
    );
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toBe(
      "awk: asort: a user comparison function is not supported\n",
    );
    expect(r.exitCode).toBe(2);
  });

  test("a coprocess is refused before anything runs", async () => {
    const r = await new Bash().exec(
      `awk 'BEGIN { print "ran" } { print $1 |& "cat" }'`,
      { stdin: "a\n" },
    );
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("awk: |& is not supported\n");
    expect(r.exitCode).toBe(2);
  });

  for (const call of [
    'strtonum("0x1A")',
    'patsplit("a b", a)',
    "isarray(a)",
    "typeof (a)",
    "and(1, 3)",
  ]) {
    const name = call.slice(0, call.search(/[ (]/));
    test(`a gawk builtin we lack, ${name}, is refused before anything runs`, async () => {
      const r = await new Bash().exec(
        `awk 'BEGIN { print "before" } END { x = ${call} }'`,
      );
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`awk: ${name} is not supported\n`);
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
