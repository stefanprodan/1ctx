// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// jq the way agents use it (kubectl and GitHub API output, package.json,
// NDJSON logs, Terraform and AWS output, raw lines), against what jq
// 1.8.2 answered, recorded by scripts/record/jq.ts.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import type { Fixture } from "../../../scripts/record/cases.ts";
import recorded from "../../fixtures/just-bash/jq-agent.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([
  // jq 1.8 prints a number as written until arithmetic touches it
  // (10.50, 1.0, 1E+2) and keeps integers past 2^53; ours are doubles
  "pretty print numbers",
  "pretty tf",
  "--slurpfile",
  "tf values",
  "tf non sensitive",
  "tf number",
  "number output",
  "tostring float",
  "@text price",
  "-n large int",
  "-n float",
  "--stream",
  "@csv numbers floats",
  // --seq is not taken
  "--seq",
  // leaf_paths is kept, which jq 1.8 removed
  "leaf_paths",
]);

describe("jq as agents use it, as jq 1.8", () => {
  recordedCases("jq", recorded as Fixture, KNOWN);
});

// jq on glibc honours strftime's case flags and widths, which the jq the
// fixture was recorded with does not; these are GNU date's answers, the
// same strftime code as glibc's, with jq's GMT for %Z
describe("jq strftime flags, as glibc", () => {
  test("case flags and widths", async () => {
    const format =
      "%^a|%#b|%#A|%^B|%5Y|%_5Y|%3d|%10A|%010A|%#Z|%#p|%^p|%10D|%010R|%^c|%5j|%_3e";
    const result = await new Bash({ env: { TZ: "UTC" } }).exec(
      `jq -nr '1699000000 | strftime("${format}")'`,
    );
    expect(result.stdout).toBe(
      "FRI|NOV|FRIDAY|NOVEMBER|02023| 2023|003|    Friday|0000Friday|gmt|am|AM|  11/03/23|0000008:26|FRI NOV  3 08:26:40 2023|00307|  3\n",
    );
  });

  // glibc pads - with blanks and writes an E or O it does not take as is
  test("- with a width, and E and O glibc refuses", async () => {
    const result = await new Bash({ env: { TZ: "UTC" } }).exec(
      `jq -nr '1699000000 | strftime("%-5d|%-10A|%Ed|%OY|%Ey|%Od")'`,
    );
    expect(result.stdout).toBe("    3|    Friday|%Ed|%OY|23|03\n");
  });

  // a width past jq's buffer fails before the text is built
  test("a width past jq's buffer", async () => {
    const result = await new Bash().exec(
      `jq -n '0 | strftime("%1000000000d")'`,
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("strftime/1: unknown system failure");
  });
});

// -f as jq 1.8.2 answered over the same files: stdout, the first stderr
// line and the exit code
describe("jq -f, as jq 1.8", () => {
  const files = {
    "/w/prog.jq": ".a\n",
    "/w/in.json": '{"a":"x"}\n',
    "/w/pos.jq": "$ARGS.positional\n",
    "/w/empty.jq": "",
  };
  const run = async (script: string) => {
    const result = await new Bash({ files, cwd: "/w" }).exec(script);
    return {
      stdout: result.stdout,
      stderr: result.stderr.split("\n")[0],
      exitCode: result.exitCode,
    };
  };
  const cases: [string, string, string, number][] = [
    ["jq -f prog.jq in.json", '"x"\n', "", 0],
    ["jq prog.jq in.json -f", '"x"\n', "", 0],
    ["jq --from-file prog.jq in.json", '"x"\n', "", 0],
    ["jq -rf prog.jq in.json", "x\n", "", 0],
    ["jq -nf pos.jq --args a b", '[\n  "a",\n  "b"\n]\n', "", 0],
    ["jq -n -f pos.jq --args a b", '[\n  "a",\n  "b"\n]\n', "", 0],
    ["jq -f -f prog.jq in.json", '"x"\n', "", 0],
    ["jq -f prog.jq -n", "null\n", "", 0],
    ["echo '{\"a\":1}' | jq -f prog.jq", "1\n", "", 0],
    [
      "jq -f missing.jq in.json",
      "",
      "jq: Could not open missing.jq: No such file or directory",
      2,
    ],
    [
      "jq -nf missing.jq",
      "",
      "jq: Could not open missing.jq: No such file or directory",
      2,
    ],
  ];
  test.each(cases)("%s", async (command, stdout, stderr, exitCode) => {
    expect(await run(command)).toEqual({ stdout, stderr, exitCode });
  });

  // jq reads in.json as the program; our parse error words differ
  test("-f after the inputs reads the first operand as the program", async () => {
    const result = await run("jq in.json -f prog.jq");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(5);
  });

  // jq: "jq: Unknown option --from-file=prog.jq", exit 2
  test("--from-file= is an unknown option", async () => {
    expect(await run("jq --from-file=prog.jq in.json")).toEqual({
      stdout: "",
      stderr: "jq: unrecognized option '--from-file=prog.jq'",
      exitCode: 1,
    });
  });

  // jq prints its usage on stderr, exit 2; ours is the help text
  test("-f with no operand prints the usage", async () => {
    const result = await new Bash().exec("jq -f");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("-f, --from-file");
    expect(result.exitCode).toBe(2);
  });

  // jq exits 3 with "Top-level program not given"
  test("an empty program file is a parse error", async () => {
    const result = await run("jq -f empty.jq in.json");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(5);
  });
});
