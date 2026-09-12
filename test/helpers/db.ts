// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A database for a test: in memory by default, a temp file when the
// test needs WAL, a reopen or a migration from a frozen fixture.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, open } from "../../src/server/db/index.ts";

export function memoryDb(): Db {
  return open(":memory:");
}

export function fileDb(): { db: Db; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-test-"));
  const path = join(dir, "test.sqlite");
  const db = open(path);
  return {
    db,
    path,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
