// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  inspect,
  migrate,
  release,
} from "../../../src/server/db/index.ts";
import { MIGRATIONS } from "../../../src/server/db/migrations/index.ts";
import { snapshot as preflight } from "../../../src/server/db/snapshot.ts";
import { provisionPaths } from "../../../src/server/provision/index.ts";
import { fileDb } from "../../helpers/db.ts";
import {
  changes,
  documents,
  network,
  object,
  recompose,
  snapshot,
} from "./helpers.ts";

test("preflight migrates a missing database only in memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-inspect-"));
  const path = join(dir, "new.sqlite");
  try {
    using db = inspect(path);
    expect(db.query("select count(*) as n from users").get()).toEqual({ n: 0 });
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A copy of the file costs memory the size of the database, which an
// instance outgrows long before its disk.
test.serial("preflight copies nothing of the database into memory", () => {
  const file = fileDb();
  const serialize = spyOn(Database.prototype, "serialize");
  const deserialize = spyOn(Database, "deserialize");
  try {
    const db = inspect(file.path);
    release(db);
    expect(serialize).not.toHaveBeenCalled();
    expect(deserialize).not.toHaveBeenCalled();
  } finally {
    serialize.mockRestore();
    deserialize.mockRestore();
    file.cleanup();
  }
});

const rebuild = MIGRATIONS.findIndex((m) => m.id === "0039-restart-runs");

const schema = (db: Database) =>
  db.query("select name, sql from sqlite_master order by name").all();

// a file migrated up to a rebuild, with rows the rebuild must keep
function oldFile(path: string) {
  const old = new Database(path, { strict: true });
  old.exec("pragma journal_mode = wal");
  old.exec("pragma foreign_keys = on");
  migrate(old, MIGRATIONS.slice(0, rebuild));
  old.exec(`
    insert into users (id, username, full_name, email, role,
      password_hash, created_at) values ('u', 'admin', '', '', 'admin', '', 1);
    insert into providers (id, name, wire, base_url, created_at)
      values ('p', 'p', 'openrouter', 'http://p.test', 1);
    insert into agents (id, name, provider_id, model, model_name, created_at)
      values ('a', 'a', 'p', 'm', 'm', 1);
    insert into projects (id, kind, name, owner_id, created_at)
      values ('j', 'personal', 'personal', 'u', 1);
    insert into sessions (id, project_id, owner_id, agent_id, origin, title,
      status, created_at, last_activity_at)
      values ('s', 'j', 'u', 'a', 'chat', 't', 'done', 1, 1);
    insert into memory_views (session_id, snapshot, seen)
      values ('s', '[]', '[]');
  `);
  const before = schema(old);
  const applied = old.query("select id from migrations").all();
  old.close();
  return { before, applied };
}

test("preflight migrates the file only inside a transaction it rolls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-inspect-"));
  const path = join(dir, "old.sqlite");
  try {
    const { before, applied } = oldFile(path);

    const db = inspect(path);
    try {
      expect(db.query("select count(*) as n from migrations").get()).toEqual({
        n: MIGRATIONS.length,
      });
      // the rebuild's drop must not cascade into the rows it keeps
      expect(db.query("select count(*) as n from memory_views").get()).toEqual({
        n: 1,
      });
    } finally {
      release(db);
    }

    using after = new Database(path, { readonly: true, strict: true });
    expect(schema(after)).toEqual(before);
    expect(after.query("select id from migrations").all()).toEqual(applied);
    expect(after.query("select count(*) as n from memory_views").get()).toEqual(
      { n: 1 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// a writer that waits for no lock, so a lock left behind fails at once
function writeNow(path: string) {
  using db = new Database(path, { strict: true });
  db.exec("pragma busy_timeout = 0");
  db.exec("create table if not exists write_probe (value text)");
  db.exec("insert into write_probe values ('x')");
}

function unchanged(path: string, before: unknown[], applied: unknown[]): void {
  using after = new Database(path, { readonly: true, strict: true });
  expect(schema(after)).toEqual(before);
  expect(after.query("select id from migrations").all()).toEqual(applied);
  expect(after.query("select count(*) as n from memory_views").get()).toEqual({
    n: 1,
  });
  expect(after.query("pragma integrity_check").get()).toEqual({
    integrity_check: "ok",
  });
}

test("preflight rolls back and frees the file when validation fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-inspect-"));
  const path = join(dir, "old.sqlite");
  const yaml = join(dir, "web.yaml");
  try {
    const { before, applied } = oldFile(path);
    writeFileSync(
      yaml,
      JSON.stringify(object("Tool", "web", { mode: "listed", domains: [] })),
    );
    const fake = network();
    const now = { value: 1_000_000 };
    let migrated = 0;
    await expect(
      provisionPaths({
        paths: [yaml],
        dbPath: path,
        compose: (db: Db) => {
          migrated = db
            .query<{ n: number }, []>("select count(*) as n from migrations")
            .get()!.n;
          return recompose({ db, now }, fake.fetcher);
        },
      }),
    ).rejects.toThrow("spec.domains list at least one host");
    expect(migrated).toBe(MIGRATIONS.length);

    unchanged(path, before, applied);
    writeNow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight rolls back and frees the file when a migration fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-inspect-"));
  const path = join(dir, "old.sqlite");
  try {
    const { before, applied } = oldFile(path);
    const failing = {
      id: "9999-fails",
      up: () => {
        throw new Error("migration failed");
      },
    };
    // inspect()'s own path, with a failing migration after the rebuild
    const db = preflight(path);
    try {
      expect(() =>
        migrate(db, [...MIGRATIONS.slice(0, rebuild + 1), failing]),
      ).toThrow("migration failed");
      expect(db.query("select count(*) as n from migrations").get()).toEqual({
        n: rebuild + 1,
      });
    } finally {
      release(db);
    }

    unchanged(path, before, applied);
    writeNow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer during preflight is refused and then writes after it", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-inspect-"));
  const path = join(dir, "old.sqlite");
  try {
    const { before, applied } = oldFile(path);
    const db = inspect(path);
    try {
      expect(() => writeNow(path)).toThrow("database is locked");
      // a reader still sees the committed file, not the migrations
      using reader = new Database(path, { readonly: true, strict: true });
      expect(reader.query("select id from migrations").all()).toEqual(applied);
    } finally {
      release(db);
    }

    unchanged(path, before, applied);
    writeNow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight reads committed WAL rows without changing their source", () => {
  const file = fileDb();
  try {
    file.db.exec("create table inspection_probe (value text)");
    file.db.exec("insert into inspection_probe values ('before')");
    using copy = inspect(file.path);
    expect(copy.query("select value from inspection_probe").get()).toEqual({
      value: "before",
    });

    copy.exec("update inspection_probe set value = 'after'");
    expect(file.db.query("select value from inspection_probe").get()).toEqual({
      value: "before",
    });
  } finally {
    file.cleanup();
  }
});

test("offline web validation reads stored domains and mode from a database snapshot", async () => {
  const file = fileDb();
  const fake = network();
  const now = { value: 1_000_000 };
  const app = await recompose({ db: file.db, now }, fake.fetcher);
  try {
    await app.provision.apply(
      documents(
        object("Tool", "web", {
          mode: "listed",
          domains: ["docs.example.test"],
        }),
        object("Tool", "websearch", { provider: null }),
      ),
      () => {},
    );
    const before = snapshot(file.db);
    const count = changes(file.db);
    using copy = inspect(file.path);
    const check = await recompose({ db: copy, now }, fake.fetcher);
    try {
      const copyBefore = snapshot(copy);
      const copyCount = changes(copy);
      expect(() =>
        check.provision.validate(
          documents(object("Tool", "web", { mode: "listed" })),
        ),
      ).not.toThrow();
      expect(() =>
        check.provision.validate(
          documents(object("Tool", "web", { domains: [] })),
        ),
      ).toThrow("spec.domains list at least one host");
      expect(() =>
        check.provision.validate(
          documents(object("Tool", "web", { mode: "off", domains: [] })),
        ),
      ).not.toThrow();
      expect(snapshot(copy)).toEqual(copyBefore);
      expect(changes(copy)).toBe(copyCount);
      expect(snapshot(file.db)).toEqual(before);
      expect(changes(file.db)).toBe(count);
      expect(fake.calls).toEqual([]);
    } finally {
      await check.shutdown();
    }
  } finally {
    await app.shutdown();
    file.cleanup();
  }
});
