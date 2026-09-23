// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Runs every case of test/fixtures/just-bash/awk-gawk.json through the
// real gawk and rewrites its answers in place: stdout, the exit code and
// whether gawk wrote to stderr. Run by hand (`bun scripts/gawk-record.ts`);
// the suite only reads the fixture. It names the cases whose answer moved,
// so a gawk upgrade is read before it is committed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface AwkCase {
  name: string;
  args: string[];
  stdin?: string;
  files?: Record<string, string>;
  stdout?: string;
  exit?: number;
  stderr?: boolean;
}

export interface AwkFixture {
  gawk: string;
  cases: AwkCase[];
}

const FIXTURE = join(
  import.meta.dir,
  "..",
  "test",
  "fixtures",
  "just-bash",
  "awk-gawk.json",
);
const LOCALE = "en_US.UTF-8";

const gawk = Bun.which("gawk");
if (!gawk) {
  console.error("gawk-record: gawk is not installed");
  process.exit(1);
}

const version = Bun.spawnSync([gawk, "--version"])
  .stdout.toString()
  .split("\n")[0];
const fixture = (await Bun.file(FIXTURE).json()) as AwkFixture;

const names = new Set<string>();
const moved: string[] = [];
for (const c of fixture.cases) {
  if (names.has(c.name)) {
    console.error(`gawk-record: two cases named ${JSON.stringify(c.name)}`);
    process.exit(1);
  }
  names.add(c.name);

  const dir = mkdtempSync(join(tmpdir(), "gawk-record-"));
  try {
    for (const [name, text] of Object.entries(c.files ?? {})) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const run = Bun.spawnSync([gawk, ...c.args], {
      cwd: dir,
      stdin: new TextEncoder().encode(c.stdin ?? ""),
      env: { PATH: "/usr/bin:/bin", HOME: dir, LC_ALL: LOCALE },
      timeout: 10_000,
    });
    const answer = {
      stdout: run.stdout.toString(),
      exit: run.exitCode ?? -1,
      stderr: run.stderr.length > 0,
    };
    if (
      c.stdout !== answer.stdout ||
      c.exit !== answer.exit ||
      c.stderr !== answer.stderr
    ) {
      moved.push(c.stdout === undefined ? `${c.name} (new)` : c.name);
    }
    Object.assign(c, answer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (fixture.gawk !== version) moved.unshift(`gawk: ${version}`);
fixture.gawk = version;
await Bun.write(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
for (const line of moved) console.log(`moved: ${line}`);
console.log(
  `gawk-record: ${fixture.cases.length} cases, ${moved.length} moved`,
);
