// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Our awk against what gawk answered for the same program and input,
// recorded in test/fixtures/just-bash/awk-gawk.json by
// scripts/gawk-record.ts. stderr is not compared, since gawk's words name
// itself; a case where gawk failed with a message expects one from us.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import type { AwkFixture } from "../../../scripts/gawk-record.ts";
import recorded from "../../fixtures/just-bash/awk-gawk.json";

const fixture = recorded as AwkFixture;

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([
  "idiom: number output",
  "idiom: length of the line",
  "idiom: while do for",
  "idiom: printf %d of a numeric prefix",
  "idiom: printf %i and %5.1f",
  "records: chat match array extraction",
  "fields: default FS trims and splits runs",
  "chars: length",
  "chars: substr",
  "chars: index",
  "chars: RSTART and RLENGTH",
  "chars: length of a line",
  "chars: split on empty FS",
  "chars: printf width over an emoji",
  "chars: printf precision over an emoji",
  "chars: printf %c of a string",
  "match: groups and positions",
  "match: a pre-filled array is cleared",
  "match: no match leaves the array empty",
  "match: an empty match",
  "match: an optional group that did not take part",
  "match: a custom SUBSEP",
  "match: nested groups",
  "match: an emoji before the match",
  "match: an array passed into a function",
  "match: a scalar third argument",
  "match: a repeated group keeps its last",
  "match: a dynamic regex string",
  "split: default with seps",
  "split: a single character with seps",
  "split: a regex with seps",
  "split: pre-filled arrays are cleared",
  "split: a scalar fourth argument",
  "split: the same array twice",
  "split: an empty string",
  "split: a single space character is the default",
  "counts: length above",
  "counts: substr below",
  "counts: substr above",
  "counts: index below",
  "counts: index above",
  "counts: split below",
  "counts: split above",
  "counts: sub below",
  "counts: sub above",
  "counts: gsub below",
  "counts: gsub above",
  "counts: match below",
  "counts: match above",
  "counts: gensub below",
  "counts: gensub above",
  "counts: tolower below",
  "counts: tolower above",
  "counts: toupper below",
  "counts: toupper above",
  "counts: int below",
  "counts: int above",
  "counts: sqrt below",
  "counts: sqrt above",
  "counts: sin below",
  "counts: sin above",
  "counts: cos below",
  "counts: cos above",
  "counts: log below",
  "counts: log above",
  "counts: exp below",
  "counts: exp above",
  "counts: atan2 below",
  "counts: atan2 above",
  "counts: rand above",
  "counts: srand above",
  "counts: system below",
  "counts: system above",
  "counts: close below",
  "counts: close above",
  "counts: fflush above",
  "counts: systime above",
  "counts: mktime below",
  "counts: mktime above",
  "counts: strftime above",
  "counts: a miscount in a rule that never runs",
  "counts: a miscount in a function never called",
  "counts: sprintf with no arguments",
  "counts: a function named after a builtin",
  "counts: a valid length with no parentheses",
  "fix: -F dot",
  "fix: -F pipe",
  "fix: length of an array",
  "fix: length of an array through a function",
  "fix: a reference statement creates the element",
  "fix: a read creates the element",
  "fix: length of an element creates it",
  "fix: an element as a function argument creates it",
  "fix: ARGV[99] creates",
  "fix: ENVIRON read creates",
  "fix: a scalar used as an array",
  "fix: an array used as a scalar",
  "fix: a subscript follows CONVFMT",
  "fix: a subscript of a fraction by default",
  "fix: log of a negative",
  "fix: minus log of zero",
  "fix: 2^1024",
  "fix: 1e30",
  "fix: 2^53+1",
  "fix: one third",
  "fix: a big literal",
  "fix: int truncates toward zero",
  "fix: %d truncates toward zero",
  "fix: %e writes two exponent digits",
  "fix: %g writes two exponent digits",
  "fix: CONVFMT on conversion",
  "fix: 0.1+0.2 as a string",
  "fix: printf %s of a fraction",
  "fix: a number assigned to a field",
  "fix: a number compared with a string",
  "fix: an undefined function reached",
  "fix: an infinity through printf",
]);

const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

async function run(c: AwkFixture["cases"][number]) {
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(c.files ?? {})) {
    files[`/work/${name}`] = text;
  }
  const bash = new Bash({ files, cwd: "/work" });
  return bash.exec(`awk ${c.args.map(quote).join(" ")}`, {
    stdin: c.stdin ?? "",
    rawScript: true,
  });
}

describe("awk answers as gawk does", () => {
  test("every known difference names a case", () => {
    const names = new Set(fixture.cases.map((c) => c.name));
    expect([...KNOWN].filter((name) => !names.has(name))).toEqual([]);
  });

  for (const c of fixture.cases) {
    test(c.name, async () => {
      const r = await run(c);
      const got = {
        stdout: r.stdout,
        exit: r.exitCode,
        stderr: c.exit !== 0 && c.stderr ? r.stderr !== "" : c.stderr,
      };
      const want = {
        stdout: c.stdout ?? "",
        exit: c.exit ?? -1,
        stderr: c.stderr,
      };
      if (KNOWN.has(c.name)) {
        expect(got).not.toEqual(want);
      } else {
        expect(got).toEqual(want);
      }
    });
  }
});
