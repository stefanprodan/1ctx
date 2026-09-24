// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// grep -P on RE2: what the Perl syntax is rewritten to, and the words of
// what is refused, which the recorded fixture does not compare.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import { translatePcre } from "../../../vendor/just-bash/src/commands/search-engine/pcre.ts";

async function run(command: string, files: Record<string, string> = {}) {
  const bash = new Bash({
    files: { "/work/hay": "x\n", ...files },
    cwd: "/work",
  });
  return bash.exec(command);
}

describe("grep -P's rewrites", () => {
  test("a leading lookbehind is a prefix left out of the match", () => {
    expect(translatePcre("(?<=id=)\\d+")).toEqual({
      source: "(?:(?:id=))(\\d+)",
      keepGroup: 1,
    });
  });

  test("a trailing lookahead is a suffix left out of the match", () => {
    expect(translatePcre("(a)b(?=c)")).toEqual({
      source: "(?:)((a)b)(?:c)",
      keepGroup: 1,
    });
  });

  test("the kept group counts the groups before it", () => {
    expect(translatePcre("(?<=(x))(y)\\K(z)").keepGroup).toBe(3);
  });

  test("leading flags stay in front of a lookbehind", () => {
    expect(translatePcre("(?i)(?<=a)b").source).toBe("(?i)(?:(?:a))(b)");
  });

  test("only the last \\K counts", () => {
    expect(translatePcre("a\\Kb\\Kc").source).toBe("(?:ab)(c)");
  });

  test("a \\K inside groups moves out of them", () => {
    expect(translatePcre("(?i:a(b\\Kc))")).toEqual({
      source: "(?:(?i:a(b)))((?i:(?:c)))",
      keepGroup: 2,
    });
  });

  test("-x puts the anchors around the kept part", () => {
    expect(translatePcre("(?<=a)b(?=c)", true)).toEqual({
      source: "(?:a)^(?:)(b)$(?:c)",
      keepGroup: 1,
      anchored: true,
    });
  });

  test("a pattern without lookaround or \\K keeps no group", () => {
    expect(translatePcre("a(?:b)c")).toEqual({ source: "a(?:b)c" });
  });

  test("\\h and \\R are PCRE2's sets", () => {
    expect(translatePcre("\\h").source).toStartWith("[\\t \\x{a0}");
    expect(translatePcre("\\R").source).toBe(
      "(?:\\r\\n|[\\n\\x0b\\f\\r\\x{85}\\x{2028}\\x{2029}])",
    );
  });

  test("named groups become RE2's", () => {
    expect(translatePcre("(?P<a>x)(?'b'y)").source).toBe("(?<a>x)(?<b>y)");
  });

  test("a comment group is dropped", () => {
    expect(translatePcre("a(?# note )b").source).toBe("ab");
  });

  test("an escaped or classed plus is no possessive", () => {
    expect(translatePcre("\\++[+]+").source).toBe("\\++[+]+");
  });

  test("a lookahead matches as GNU's on the line and with -o", async () => {
    const result = await run("grep -onP 'a(?=a)' aaa; grep -cxP 'a(?=b)' ab", {
      "/work/aaa": "aaa\n",
      "/work/ab": "ab\n",
    });
    expect(result.stdout).toBe("1:a\n1:a\n0\n");
  });

  test("a caseless category runs under -i", async () => {
    const result = await run("grep -oiP '\\p{N}+|\\s' hay", {
      "/work/hay": "a² 1\n",
    });
    expect(result.stdout).toBe("²\n \n1\n");
  });
});

describe("grep -P's refusals", () => {
  const refused: [string, string][] = [
    ["(a)\\1", "backreference \\1 is not supported"],
    ["(?<n>a)\\k<n>", "backreference \\k is not supported"],
    ["(a)\\g{-1}", "backreference \\g is not supported"],
    ["(?P<n>a)(?P=n)", "backreference (?P= is not supported"],
    ["a(?!b)", "negative lookahead (?! is not supported"],
    ["(?<!a)b", "negative lookbehind (?<! is not supported"],
    ["a++", "a possessive quantifier is not supported"],
    ["a{2}+", "a possessive quantifier is not supported"],
    ["(?>ab)", "an atomic group (?> is not supported"],
    ["a(?R)?b", "recursion is not supported"],
    ["(a)(?1)", "recursion is not supported"],
    ["(a)?(?(1)b|c)", "a conditional group (?( is not supported"],
    ["(?|(a)|(b))", "a branch reset group (?| is not supported"],
    ["a(*SKIP)b", "a backtracking verb (* is not supported"],
    ["a(?<=b)c", "lookbehind (?<= is supported only at the start"],
    ["a(?=b)c", "lookahead (?= is supported only at the end"],
    ["(a(?=b))", "lookahead (?= is supported only at the end"],
    ["(a\\Kb)+", "\\K is supported inside a group only when no group"],
    ["(a|b\\Kc)", "\\K is supported inside a group only when no group"],
    ["(?<=a\\Kb)c", "\\K is not allowed in lookarounds"],
    ["(?<=a)b|c", "lookaround and \\K are supported only beside"],
    ["[[:nope:]]", "unknown POSIX class name nope"],
  ];
  for (const [pattern, words] of refused) {
    test(pattern, async () => {
      const result = await run(`grep -P '${pattern}' hay`);
      expect(result.stderr).toStartWith(`grep: ${words}`);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(2);
    });
  }

  test("a hostile pattern on a long line finishes in linear time", async () => {
    const line = `${"a".repeat(10_000)}\n`;
    const started = performance.now();
    const result = await run(
      "grep -cP '(a|aa)*(?=b)' hay; grep -cP '(\\w+\\s?)*$' hay",
      {
        "/work/hay": line,
      },
    );
    expect(result.stdout).toBe("0\n1\n");
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("grep's other words", () => {
  test("-V and --version answer as GNU grep 3.12", async () => {
    const result = await run("grep -V; grep --version -q x hay");
    const version =
      "grep (GNU grep) 3.12\n" +
      "Copyright (C) 2025 Free Software Foundation, Inc.\n" +
      "License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n" +
      "This is free software: you are free to change and redistribute it.\n" +
      "There is NO WARRANTY, to the extent permitted by law.\n";
    expect(result.stdout).toBe(version + version);
    expect(result.exitCode).toBe(0);
  });

  test("--color=always is refused", async () => {
    const result = await run("grep --color=always x hay");
    expect(result.stderr).toBe(
      "grep: --color=always is not supported: output is always plain\n",
    );
    expect(result.exitCode).toBe(2);
  });

  test("an unknown --color word shows the help, as GNU does", async () => {
    const result = await run("grep --color=rainbow x hay");
    expect(result.stdout).toStartWith("grep - print lines that match");
    expect(result.exitCode).toBe(0);
  });

  test("a missing --exclude-from file is an error", async () => {
    const result = await run("grep -r --exclude-from=nope x .");
    expect(result.stderr).toBe("grep: nope: No such file or directory\n");
    expect(result.exitCode).toBe(2);
  });
});
