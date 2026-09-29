// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Checks that GNU patch 2.8 applies our diff's unified and context output
// of every pair of text files the diff fixture compares, giving back the
// second file byte for byte: `bun scripts/diff-patch-check.ts`, with
// Homebrew's GNU patch on the PATH as `gpatch`. Run by hand.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bash, InMemoryFs } from "just-bash";
import { type Fixture, fileBytes } from "./record-cases.ts";

const patch = Bun.which("gpatch") ? "gpatch" : "patch";
const version = Bun.spawnSync([patch, "--version"]).stdout.toString();
if (!/GNU patch 2\.8\b/.test(version)) {
  console.error(`${patch} is not GNU patch 2.8: ${version.split("\n")[0]}`);
  process.exit(1);
}

const fixture = JSON.parse(
  await readFile(
    new URL("../test/fixtures/just-bash/diff-gnu.json", import.meta.url),
    "utf8",
  ),
) as Fixture;
const files = fixture.files;
const text = (name: string) => {
  const value = files[name];
  if (value === undefined) return false;
  return !fileBytes(value).slice(0, 4096).includes(0);
};

const pairs = new Map<string, [string, string]>();
for (const c of fixture.cases) {
  const operands = c.args.filter((a) => a in files);
  if (operands.length !== 2 || operands[0] === operands[1]) continue;
  const [first, second] = operands;
  if (Bun.deepEquals(fileBytes(files[first]), fileBytes(files[second]))) {
    continue;
  }
  if (text(first) && text(second))
    pairs.set(`${first}\0${second}`, [first, second]);
}

const dir = await mkdtemp(join(tmpdir(), "diff-patch-"));
let failed = 0;
let applied = 0;
try {
  for (const [first, second] of pairs.values()) {
    for (const format of ["-u", "-c"]) {
      const fs = new InMemoryFs({}, {});
      fs.writeFileSync("/w/a", fileBytes(files[first]));
      fs.writeFileSync("/w/b", fileBytes(files[second]));
      const bash = new Bash({ fs, cwd: "/w" });
      const run = await bash.exec(`diff ${format} a b > p; echo $?`);
      if (run.stdout !== "1\n") {
        failed++;
        console.log(
          `${format} ${first} ${second}: diff answered ${run.stdout.trim()}`,
        );
        continue;
      }
      await writeFile(join(dir, "a"), fileBytes(files[first]));
      await writeFile(join(dir, "p"), await fs.readFileBuffer("/w/p"));
      const applyRun = Bun.spawnSync(
        [patch, "-s", "-o", "out", "a", "-i", "p"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      const out = new Uint8Array(await readFile(join(dir, "out")));
      if (
        applyRun.exitCode !== 0 ||
        !Bun.deepEquals(out, fileBytes(files[second]))
      ) {
        failed++;
        console.log(
          `${format} ${first} ${second}: patch exit ${applyRun.exitCode} ${applyRun.stderr.toString().trim()}`,
        );
      } else {
        applied++;
      }
      await rm(join(dir, "out"), { force: true });
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(
  `${applied} patches applied, ${failed} failed, over ${pairs.size} pairs`,
);
process.exit(failed === 0 ? 0 : 1);
