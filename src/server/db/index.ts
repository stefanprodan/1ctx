// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A transaction body returns its events instead of publishing them, so
// they go out only after the outermost commit and never on a throw.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type BusEvent, publish } from "../lib/bus.ts";
import type { Migration } from "./migration.ts";
import { MIGRATIONS } from "./migrations/index.ts";
import { snapshot } from "./snapshot.ts";

export type Db = Database;

export type Transaction<T> = { result: T; events?: BusEvent[] };

export function open(path: string): Db {
  const db = new Database(path, { create: true, strict: true });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma busy_timeout = 5000");
  migrate(db);
  return db;
}

// Whether this process can have the file to itself. A running server
// keeps the database open, and it would not see a write from outside:
// its caches, its runner locks and its open sockets all go on as they
// were. An exclusive lock is refused while anyone else holds it, so
// taking one and letting it go is the question being asked.
export function heldByAnother(path: string): boolean {
  if (path === ":memory:" || !existsSync(path)) return false;
  const db = new Database(path, { strict: true });
  try {
    db.exec("pragma locking_mode = exclusive");
    db.exec("begin immediate");
    db.exec("commit");
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

export function inspect(path: string): Db {
  const db = snapshot(path);
  try {
    db.exec("pragma foreign_keys = on");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: Db, list: readonly Migration[] = MIGRATIONS) {
  db.exec(
    "create table if not exists migrations (id text primary key, applied_at integer not null)",
  );
  const applied = new Set(
    db
      .query<{ id: string }, []>("select id from migrations")
      .all()
      .map((row) => row.id),
  );
  const ran: string[] = [];
  for (const migration of list) {
    if (applied.has(migration.id)) continue;
    if (migration.rebuild) db.exec("pragma foreign_keys = off");
    try {
      db.transaction(() => {
        migration.up(db);
        if (migration.rebuild) {
          const broken = db.query("pragma foreign_key_check").get();
          if (broken !== null) throw new Error("foreign key check failed");
        }
        db.query("insert into migrations (id, applied_at) values (?, ?)").run(
          migration.id,
          Date.now(),
        );
      })();
    } finally {
      if (migration.rebuild) db.exec("pragma foreign_keys = on");
    }
    ran.push(migration.id);
  }
  return ran;
}

// A body that throws truncates back to where it started, so a savepoint
// that rolled back leaves no event behind, even when a body above it
// catches the throw and commits.
const pending = new WeakMap<Db, BusEvent[]>();

export function transact<T>(db: Db, body: () => Transaction<T>): T {
  const outermost = !pending.has(db);
  if (outermost) pending.set(db, []);
  const events = pending.get(db)!;
  const mark = events.length;
  try {
    const tx = db.transaction(body)();
    events.push(...(tx.events ?? []));
    if (outermost) {
      pending.delete(db);
      for (const event of events) publish(event);
    }
    return tx.result;
  } catch (err) {
    if (outermost) pending.delete(db);
    else events.length = mark;
    throw err;
  }
}
