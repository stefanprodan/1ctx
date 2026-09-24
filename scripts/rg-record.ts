// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records ripgrep 15's answers into the fixture the rg tests compare
// against: `bun scripts/rg-record.ts`, with ripgrep on the PATH as `rg`.
// Its config file holds --no-require-git, so the ignore files apply
// outside a git repository, as ours always applies them.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "./record-cases.ts";

// outside the searched directory, or --files would list it
const dir = await mkdtemp(join(tmpdir(), "rg-config-"));
try {
  const config = join(dir, "ripgreprc");
  await writeFile(config, "--no-require-git\n");
  await record(
    "rg",
    new URL("../test/fixtures/just-bash/rg-ripgrep.json", import.meta.url)
      .pathname,
    /^ripgrep 15\./,
    // ripgrep reads a piped stdin in place of the directory
    { env: { RIPGREP_CONFIG_PATH: config }, nullStdin: true },
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
