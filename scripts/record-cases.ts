// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records what a reference binary answers for each case of a fixture under
// test/fixtures/just-bash/, for yq-record.ts and jq-record.ts. Run by hand;
// the suite reads the fixture and never needs the binary.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  files: Record<string, string>;
  cases: RecordedCase[];
}

export async function record(
  binary: string,
  fixturePath: string,
  expectVersion: RegExp,
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
        await writeFile(join(dir, name), text);
      }
      const run = Bun.spawnSync([binary, ...c.args], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: dir, ...c.env },
        stdin: new TextEncoder().encode(c.stdin ?? ""),
        stdout: "pipe",
        stderr: "pipe",
      });
      const written: Record<string, string> = {};
      for (const [name, text] of Object.entries(files)) {
        const now = await readFile(join(dir, name), "utf8");
        if (now !== text) written[name] = now;
      }
      const next = {
        stdout: run.stdout.toString(),
        exit: run.exitCode ?? -1,
        error: run.exitCode !== 0 && run.stderr.toString().trim() !== "",
        written,
      };
      const before = JSON.stringify([c.stdout, c.exit, c.error, c.written]);
      c.stdout = next.stdout;
      c.exit = next.exit;
      if (next.error) c.error = true;
      else delete c.error;
      if (Object.keys(written).length > 0) c.written = written;
      else delete c.written;
      if (before !== JSON.stringify([c.stdout, c.exit, c.error, c.written])) {
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
