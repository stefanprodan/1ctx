// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records ripgrep 15's answers into the fixture the rg tests compare
// against: `bun scripts/rg-record.ts`, with ripgrep on the PATH as `rg`.
// Its config file holds --no-require-git, so the ignore files apply
// outside a git repository, as ours always applies them. It also writes
// ripgrep's type table, from `rg --type-list`, beside rg's file types.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "./record-cases.ts";

const TYPES = new URL(
  "../vendor/just-bash/src/commands/rg/file-types-data.ts",
  import.meta.url,
).pathname;

async function writeTypes(env: Record<string, string>): Promise<void> {
  const run = Bun.spawnSync(["rg", "--type-list"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  const version = Bun.spawnSync(["rg", "-V"], { stdout: "pipe" })
    .stdout.toString()
    .trim();
  const lines = run.stdout.toString().trimEnd().split("\n");
  const rows = lines.map((line) => {
    const colon = line.indexOf(": ");
    const name = line.slice(0, colon);
    const globs = line.slice(colon + 2).split(", ");
    return `  ${JSON.stringify(name)}: ${JSON.stringify(globs)},`;
  });
  await writeFile(
    TYPES,
    [
      "/**",
      ` * (1ctx) ripgrep's file types as \`rg --type-list\` of ${version} lists`,
      " * them, aliases included. Written by scripts/rg-record.ts; not edited.",
      " */",
      "",
      "export const RIPGREP_TYPES: Record<string, string[]> = {",
      ...rows,
      "};",
      "",
    ].join("\n"),
  );
  console.log(`${lines.length} types written`);
}

// outside the searched directory, or --files would list it
const dir = await mkdtemp(join(tmpdir(), "rg-config-"));
try {
  const config = join(dir, "ripgreprc");
  await writeFile(config, "--no-require-git\n");
  const env = { RIPGREP_CONFIG_PATH: config };
  await writeTypes(env);
  await record(
    "rg",
    new URL("../test/fixtures/just-bash/rg-ripgrep.json", import.meta.url)
      .pathname,
    /^ripgrep 15\./,
    // ripgrep reads a piped stdin in place of the directory
    { env, nullStdin: true },
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
