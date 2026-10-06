// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { statSync } from "node:fs";
import { CHILD_SESSIONS, type Db } from "../db/index.ts";

// a quarter hour of UTC, which every zone's midnight falls on
export const SLOT_MS = 900_000;

// a send of a root session, as a condition on the sends row named: a
// subagent's child is no turn or run of its own, though its tokens
// count
export const ROOT_SEND = (sends: string) =>
  `${sends}.session_id not in (${CHILD_SESSIONS})`;

export type ProjectRow = {
  id: string;
  kind: "personal" | "team";
  name: string;
  owner: string;
};

export const inMemory = (db: Db): boolean =>
  db.filename === "" || db.filename === ":memory:";

export const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

// one read transaction, so every statement sees the same WAL snapshot
export function snapshot<T>(db: Db, read: () => T): T {
  db.exec("begin");
  try {
    return read();
  } finally {
    db.exec("rollback");
  }
}

export const projectRows = (db: Db): ProjectRow[] =>
  db
    .query<ProjectRow, []>(
      `select p.id, p.kind, p.name, u.username as owner
         from projects p join users u on u.id = p.owner_id`,
    )
    .all();
