// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

// Preflight must not create a file or migrate the instance it inspects,
// and a copy of the file would cost memory the size of the database.
// So it works on the file itself inside a transaction that is never
// committed: release() rolls it back. Foreign keys go off before it
// begins, since a rebuild migration cannot turn them off inside one and
// its drop would cascade into the rows validation reads.
export function snapshot(path: string): Database {
  const db =
    path === ":memory:" || !existsSync(path)
      ? new Database(":memory:", { strict: true })
      : new Database(path, { readwrite: true, strict: true });
  db.exec("pragma foreign_keys = off");
  db.exec("pragma busy_timeout = 5000");
  db.exec("begin");
  return db;
}

// Closing would roll back too, but not before every statement is gone,
// and until then the write lock stays on the file the apply opens next.
export function release(db: Database) {
  if (db.inTransaction) db.exec("rollback");
  db.close();
}
