// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Runs the cases of a recorded fixture through the vendored shell and
// compares them with what the reference binary answered. stderr is not
// compared, only that a failure says something.

import { expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import type { Fixture, RecordedCase } from "../../../scripts/record-cases.ts";

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
  const bash = new Bash({ fs, cwd: "/work", env: c.env });
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

export function recordedCases(command: string, fixture: Fixture): void {
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const result = await runCase(command, fixture, c);
      const stdout = c.accept ? c.accept.stdout : c.stdout;
      const exit = c.accept ? c.accept.exit : c.exit;
      expect(result.stdout).toBe(stdout as string);
      if (exit === 0) expect(result.exitCode).toBe(0);
      else expect(result.exitCode).not.toBe(0);
      if (c.error && !c.accept) expect(result.stderr).not.toBe("");
      const written = c.accept?.written ?? c.written ?? {};
      expect(result.written).toEqual(written);
    });
  }
}
