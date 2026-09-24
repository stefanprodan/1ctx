// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records what a reference binary answers for each case of a fixture under
// test/fixtures/just-bash/, for yq-record.ts, jq-record.ts, grep-record.ts
// and rg-record.ts. Run by hand;
// the suite reads the fixture and never needs the binary.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface RecordedCase {
  name: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  /** files of this case alone, beside the fixture's shared ones */
  files?: Record<string, string>;
  stdout?: string;
  exit?: number;
  /** the binary failed with words on stderr */
  error?: boolean;
  /** the binary succeeded with words on stderr */
  warned?: boolean;
  /** stdout's lines in no fixed order, compared sorted */
  unordered?: boolean;
  /** every file the run changed, as it was left */
  written?: Record<string, string>;
  /** ours where it differs on purpose, with the reason */
  accept?: {
    stdout: string;
    exit: number;
    reason: string;
    written?: Record<string, string>;
  };
}

export interface Fixture {
  recordedWith: string;
  /** the environment of every case, under each case's own */
  env?: Record<string, string>;
  /** names may hold directories */
  files: Record<string, string>;
  cases: RecordedCase[];
}

/** The lines of a text in code point order, for unordered answers. */
export function sortLines(text: string): string {
  if (text === "") return text;
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${lines.join("\n")}\n`;
}

export async function record(
  binary: string,
  fixturePath: string,
  expectVersion: RegExp,
  options: {
    /** given to the binary alone, never written into the fixture */
    env?: Record<string, string>;
    /** a case without stdin gets /dev/null, never an empty pipe */
    nullStdin?: boolean;
  } = {},
): Promise<void> {
  const version = Bun.spawnSync([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const said =
    `${version.stdout.toString()}${version.stderr.toString()}`.trim();
  if (version.exitCode !== 0 || !expectVersion.test(said)) {
    console.error(`${binary} is not the reference binary: ${said || "none"}`);
    process.exit(1);
  }
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  fixture.recordedWith = said;
  const names = new Set<string>();
  const moved: string[] = [];
  for (const c of fixture.cases) {
    if (names.has(c.name)) throw new Error(`duplicate case: ${c.name}`);
    names.add(c.name);
    // never where the fixtures live: an -i case writes its files
    const dir = await mkdtemp(join(tmpdir(), "record-"));
    try {
      const files = { ...fixture.files, ...c.files };
      for (const [name, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await writeFile(join(dir, name), text);
      }
      const run = Bun.spawnSync([binary, ...c.args], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          ...fixture.env,
          ...c.env,
          ...options.env,
        },
        stdin:
          c.stdin === undefined && options.nullStdin
            ? "ignore"
            : new TextEncoder().encode(c.stdin ?? ""),
        stdout: "pipe",
        stderr: "pipe",
      });
      const written: Record<string, string> = {};
      for (const [name, text] of Object.entries(files)) {
        const now = await readFile(join(dir, name), "utf8");
        if (now !== text) written[name] = now;
      }
      const said = run.stderr.toString().trim() !== "";
      const next = {
        stdout: c.unordered
          ? sortLines(run.stdout.toString())
          : run.stdout.toString(),
        exit: run.exitCode ?? -1,
        error: run.exitCode !== 0 && said,
        warned: run.exitCode === 0 && said,
        written,
      };
      const before = JSON.stringify([
        c.stdout,
        c.exit,
        c.error,
        c.warned,
        c.written,
      ]);
      c.stdout = next.stdout;
      c.exit = next.exit;
      if (next.error) c.error = true;
      else delete c.error;
      if (next.warned) c.warned = true;
      else delete c.warned;
      if (Object.keys(written).length > 0) c.written = written;
      else delete c.written;
      const after = JSON.stringify([
        c.stdout,
        c.exit,
        c.error,
        c.warned,
        c.written,
      ]);
      if (before !== after) {
        moved.push(c.name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${fixture.cases.length} cases recorded with ${said}`);
  for (const name of moved) console.log(`moved: ${name}`);
}
