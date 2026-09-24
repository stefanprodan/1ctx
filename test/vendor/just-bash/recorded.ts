// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Runs the cases of a recorded fixture through the vendored shell and
// compares them with what the reference binary answered. stderr is not
// compared, only that a failure or a warning says something.

import { expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import {
  type Fixture,
  type RecordedCase,
  sortLines,
} from "../../../scripts/record-cases.ts";

export function quote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export async function runCase(
  command: string,
  fixture: Fixture,
  c: RecordedCase,
) {
  const fs = new InMemoryFs({}, {});
  const files = { ...fixture.files, ...c.files };
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(`/work/${name}`, text);
  }
  const bash = new Bash({
    fs,
    cwd: "/work",
    env: { ...fixture.env, ...c.env },
  });
  const result = await bash.exec(
    [command, ...c.args].map((a, i) => (i === 0 ? a : quote(a))).join(" "),
    { stdin: c.stdin ?? "" },
  );
  const written: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) {
    const now = await fs.readFile(`/work/${name}`);
    if (now !== text) written[name] = now;
  }
  return { ...result, written };
}

function matches(
  c: RecordedCase,
  result: Awaited<ReturnType<typeof runCase>>,
): boolean {
  const stdout = c.accept ? c.accept.stdout : c.stdout;
  const exit = c.accept ? c.accept.exit : c.exit;
  const got = c.unordered ? sortLines(result.stdout) : result.stdout;
  if (got !== stdout) return false;
  if ((exit === 0) !== (result.exitCode === 0)) return false;
  if ((c.error || c.warned) && !c.accept && result.stderr === "") return false;
  const written = c.accept?.written ?? c.written ?? {};
  return Bun.deepEquals(result.written, written);
}

/**
 * Runs every case. A case named in `known` is one we still answer
 * differently, and fails when it passes.
 */
export function recordedCases(
  command: string,
  fixture: Fixture,
  known: ReadonlySet<string> = new Set(),
): void {
  if (known.size > 0) {
    test("every known difference names a case", () => {
      const names = new Set(fixture.cases.map((c) => c.name));
      expect([...known].filter((name) => !names.has(name))).toEqual([]);
    });
  }
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const result = await runCase(command, fixture, c);
      if (known.has(c.name)) {
        expect(matches(c, result)).toBe(false);
        return;
      }
      const stdout = c.accept ? c.accept.stdout : c.stdout;
      const exit = c.accept ? c.accept.exit : c.exit;
      const got = c.unordered ? sortLines(result.stdout) : result.stdout;
      expect(got).toBe(stdout as string);
      if (exit === 0) expect(result.exitCode).toBe(0);
      else expect(result.exitCode).not.toBe(0);
      if ((c.error || c.warned) && !c.accept) {
        expect(result.stderr).not.toBe("");
      }
      const written = c.accept?.written ?? c.written ?? {};
      expect(result.written).toEqual(written);
    });
  }
}
