// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The secrets directory lists key file names by prefix, never a value.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secrets } from "../../src/server/secrets/index.ts";

test("list answers the sorted names with the prefix, and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-secrets-"));
  try {
    for (const name of ["mcp-github", "mcp-flux", "openrouter", "admin"]) {
      writeFileSync(join(dir, `${name}.key`), "value\n");
    }
    writeFileSync(join(dir, "mcp-notes.txt"), "not a key");
    writeFileSync(join(dir, "mcp-Bad.key"), "bad name");
    const store = secrets(dir, "local");
    expect(store.list("mcp-")).toEqual(["mcp-flux", "mcp-github"]);
    expect(store.list("")).toEqual([
      "admin",
      "mcp-flux",
      "mcp-github",
      "openrouter",
    ]);
    expect(store.list("nope-")).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(
    secrets(join(tmpdir(), "1ctx-missing-dir"), "local").list("mcp-"),
  ).toEqual([]);
});
