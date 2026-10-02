// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, migrate, release } from "../../../src/server/db/index.ts";
import { MIGRATIONS } from "../../../src/server/db/migrations/index.ts";
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

test("preflight migrates the file only inside a transaction it rolls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-inspect-"));
  const path = join(dir, "old.sqlite");
  const rebuild = MIGRATIONS.findIndex((m) => m.id === "0039-restart-runs");
  const schema = (db: Database) =>
    db.query("select name, sql from sqlite_master order by name").all();
  try {
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
