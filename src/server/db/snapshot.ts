// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

// Preflight must not create a file or migrate the instance it inspects.
export function snapshot(path: string): Database {
  if (path === ":memory:" || !existsSync(path)) {
    return new Database(":memory:", { strict: true });
  }
  using source = new Database(path, { readonly: true, strict: true });
  const bytes = source.serialize();
  // SQLite requires rollback-mode headers for an in-memory deserialization:
  // https://www.sqlite.org/c3ref/deserialize.html
  bytes[18] = 1;
  bytes[19] = 1;
  return Database.deserialize(bytes, { strict: true });
}
