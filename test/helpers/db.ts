// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A database for a test: in memory by default, a temp file when the
// test needs WAL, a reopen or a migration from a frozen fixture.

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, open } from "../../src/server/db/index.ts";

// Migrating is most of an app's setup, so a process migrates once and
// every memory database is a copy of those bytes. A copy keeps no
// connection pragmas, so they are set again as open() sets them. The
// migration tests open their own databases.
let template: Uint8Array | null = null;

export function memoryDb(): Db {
  if (template === null) {
    const db = open(":memory:").db;
    template = db.serialize();
    db.close();
  }
  const db = Database.deserialize(template, { strict: true });
  db.exec("pragma foreign_keys = on");
  db.exec("pragma busy_timeout = 5000");
  return db;
}

export function fileDb(): {
  db: Db;
  path: string;
  migrations: string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-test-"));
  const path = join(dir, "test.sqlite");
  const { db, migrations } = open(path);
  return {
    db,
    path,
    migrations,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
