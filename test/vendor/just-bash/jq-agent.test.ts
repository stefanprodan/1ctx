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
