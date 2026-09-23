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
  "idiom: length of the line",
  "idiom: while do for",
  "chars: length of a line",
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
  "fix: an undefined function reached",
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
