// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fresh file gets every migration once; a reopen applies none; the
// list has unique, ordered ids.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, open } from "../../src/server/db/index.ts";
import { MIGRATIONS } from "../../src/server/db/migrations/index.ts";
import { fileDb } from "../helpers/db.ts";

describe("migrations", () => {
  test("ids are unique and ordered", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^\d{4}-[a-z0-9-]+$/);
  });

  test("a fresh file gets them all and a reopen gets none", () => {
    const { db, path, cleanup } = fileDb();
    try {
      const applied = db
        .query<{ id: string }, []>("select id from migrations order by id")
        .all()
        .map((r) => r.id);
      expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
      db.close();
      const again = open(path);
      expect(migrate(again)).toEqual([]);
      again.close();
    } finally {
      cleanup();
    }
  });

  test("wal mode and foreign keys are on", () => {
    const { db, cleanup } = fileDb();
    try {
      expect(db.query("pragma journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(db.query("pragma foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      cleanup();
    }
  });

  test("a partial run is never recorded", () => {
    const db = new Database(":memory:");
    const broken = {
      id: "9999-broken",
      up: (d: Database) => {
        d.exec("create table half (x)");
        throw new Error("boom");
      },
    };
    expect(() => migrate(db, [broken])).toThrow("boom");
    expect(db.query("select count(*) as n from migrations").get()).toEqual({
      n: 0,
    });
    expect(
      db
        .query("select count(*) as n from sqlite_master where name = 'half'")
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe("0002-usage-seq", () => {
  test("orders the rows a 0001 database holds and indexes them by session", () => {
    const db = new Database(":memory:");
    migrate(db, [MIGRATIONS[0]]);
    const insert = db.query(
      `insert into usage (id, send_id, session_id, project_id, user_id, agent_id,
         provider_id, model, round, prompt_tokens, completion_tokens, created_at)
       values (?, ?, 's1', 'p', 'u', 'a', 'pr', 'm', ?, ?, 1, ?)`,
    );
    // two sends at the same time, each starting at round 1: the later
    // insert is the later row
    insert.run("u1", "send1", 1, 10, 100);
    insert.run("u2", "send1", 2, 20, 100);
    insert.run("u3", "send2", 1, 30, 100);
    insert.run("u4", "send3", 1, 40, 50);
    migrate(db);
    expect(
      db
        .query<{ id: string; seq: number }, []>(
          "select id, seq from usage order by seq",
        )
        .all(),
    ).toEqual([
      { id: "u4", seq: 1 },
      { id: "u1", seq: 2 },
      { id: "u2", seq: 3 },
      { id: "u3", seq: 4 },
    ]);
    expect(
      db
        .query("select name from sqlite_master where name = 'usage_session'")
        .get(),
    ).toEqual({ name: "usage_session" });
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
