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
const KNOWN = new Set<string>([]);

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
