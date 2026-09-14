// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fresh file gets every migration once; a reopen applies none; the
// list has unique, ordered ids.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, open } from "../../src/server/db/index.ts";
import { MIGRATIONS } from "../../src/server/db/migrations/index.ts";
import { EFFORTS } from "../../src/shared/words.ts";
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

describe("the schema", () => {
  // a fresh schema with a user, a project, an agent, a session and two
  // sends, each with its user message and its answer
  function seed() {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db);
    db.exec(`
      insert into users (id, username, full_name, email, role, password_hash, created_at)
        values ('u', 'user', 'User', 'user@example.com', 'member', 'x', 0);
      insert into projects (id, kind, name, owner_id, created_at)
        values ('p', 'personal', 'personal', 'u', 0);
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr', 'prov', 'openai-compatible', 'http://x', 0);
      insert into agents (id, name, provider_id, model, model_name, created_at)
        values ('a', 'agent', 'pr', 'm', 'M', 0);
      insert into sessions (id, project_id, owner_id, agent_id, origin, title, status, revision, created_at, last_activity_at)
        values ('sess', 'p', 'u', 'a', 'chat', 'chat', 'done', 2, 0, 0);
      insert into sends (id, session_id, kind, user_id, agent_id, provider_id, model, status, first_message_id, started_at)
        values ('send1', 'sess', 'chat', 'u', 'a', 'pr', 'm', 'done', 'm1', 0),
               ('send2', 'sess', 'compact', 'u', 'a', 'pr', 'm', 'done', 'm3', 10);
      insert into messages (id, session_id, seq, kind, send_id, round, user_id, content, status, created_at, finished_at)
        values ('m1', 'sess', 1, 'user', 'send1', 1, 'u', 'q', 'done', 0, 0);
      insert into messages (id, session_id, seq, kind, send_id, round, slot, agent_id, model, content, status, created_at, finished_at)
        values ('m2', 'sess', 2, 'reply', 'send1', 1, 'answer', 'a', 'm', 'ans', 'done', 0, 1);
      insert into messages (id, session_id, seq, kind, send_id, round, content, status, created_at, finished_at)
        values ('m3', 'sess', 3, 'summary', 'send2', 1, 'sum', 'done', 10, 11);
      insert into usage (id, send_id, session_id, project_id, user_id, agent_id, provider_id, model, round, seq, prompt_tokens, completion_tokens, created_at)
        values ('us1', 'send1', 'sess', 'p', 'u', 'a', 'pr', 'm', 1, 1, 1, 1, 0);
    `);
    return db;
  }

  test("a send's rows hold their shape, uniques and cascade", () => {
    const db = seed();
    const sends = db
      .query("select rounds, tool_calls from sends where id = 'send1'")
      .get();
    expect(sends).toEqual({ rounds: 1, tool_calls: 0 });
    // the new tool row shape is accepted; a bad shape is rejected
    db.query(
      `insert into messages (id, session_id, seq, kind, send_id, round, tool_call_id, tool_name, status, created_at)
       values ('t1', 'sess', 5, 'tool', 'send1', 1, 'c1', 'webfetch', 'streaming', 0)`,
    ).run();
    // a tool row without its call id is refused
    expect(() =>
      db
        .query(
          `insert into messages (id, session_id, seq, kind, send_id, round, tool_name, status, created_at)
           values ('t2', 'sess', 6, 'tool', 'send1', 1, 'webfetch', 'streaming', 0)`,
        )
        .run(),
    ).toThrow();
    // two answers in one send are refused
    expect(() =>
      db
        .query(
          `insert into messages (id, session_id, seq, kind, send_id, round, slot, agent_id, model, status, created_at, finished_at)
           values ('r2', 'sess', 7, 'reply', 'send1', 2, 'answer', 'a', 'm', 'done', 0, 1)`,
        )
        .run(),
    ).toThrow();
    // two streaming replies in one send are refused
    db.query(
      `insert into messages (id, session_id, seq, kind, send_id, round, agent_id, model, status, created_at)
       values ('stream1', 'sess', 8, 'reply', 'send1', 2, 'a', 'm', 'streaming', 0)`,
    ).run();
    expect(() =>
      db
        .query(
          `insert into messages (id, session_id, seq, kind, send_id, round, agent_id, model, status, created_at)
           values ('stream2', 'sess', 9, 'reply', 'send1', 3, 'a', 'm', 'streaming', 0)`,
        )
        .run(),
    ).toThrow();
    // a reply that stopped streaming must have a slot
    expect(() =>
      db
        .query(
          `insert into messages (id, session_id, seq, kind, send_id, round, agent_id, model, status, created_at, finished_at)
           values ('unplaced', 'sess', 10, 'reply', 'send2', 2, 'a', 'm', 'done', 0, 1)`,
        )
        .run(),
    ).toThrow();
    // two usage rows for one (send, round) are refused
    expect(() =>
      db
        .query(
          `insert into usage (id, send_id, session_id, project_id, user_id, agent_id, provider_id, model, round, seq, prompt_tokens, completion_tokens, created_at)
           values ('dup', 'send1', 'sess', 'p', 'u', 'a', 'pr', 'm', 1, 2, 1, 1, 0)`,
        )
        .run(),
    ).toThrow();
    // the cascade: deleting the session takes its sends and messages,
    // and usage, which carries no foreign key, stays
    db.query("delete from sessions where id = 'sess'").run();
    expect(
      db
        .query("select count(*) as n from messages where session_id = 'sess'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .query("select count(*) as n from sends where session_id = 'sess'")
        .get(),
    ).toEqual({ n: 0 });
    expect(db.query("select count(*) as n from usage").get()).toEqual({
      n: 1,
    });
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("the three built-in tools start enabled and limits start empty", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(
      db
        .query(
          `select name, enabled, provider, updated_at
           from tools order by rowid`,
        )
        .all(),
    ).toEqual([
      {
        name: "get_current_time",
        enabled: 1,
        provider: null,
        updated_at: 0,
      },
      { name: "webfetch", enabled: 1, provider: null, updated_at: 0 },
      { name: "websearch", enabled: 1, provider: null, updated_at: 0 },
    ]);
    expect(db.query("select count(*) as n from limits").get()).toEqual({
      n: 0,
    });
    expect(() =>
      db
        .query(
          "insert into tools (name, enabled, updated_at) values ('other', 1, 0)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .query("update tools set provider = 'other' where name = 'websearch'")
        .run(),
    ).toThrow();
    db.close();
  });

  test("an agent's thinking and effort are null or a known word", () => {
    const db = seed();
    expect(
      db.query("select thinking, effort from agents where id = 'a'").get(),
    ).toEqual({ thinking: null, effort: null });
    // the check must know every level a wire offers: a level added to
    // EFFORTS without a migration fails here
    for (const level of new Set(Object.values(EFFORTS).flat())) {
      db.query("update agents set thinking = 'on', effort = ?").run(level);
    }
    expect(() =>
      db.query("update agents set thinking = 'maybe'").run(),
    ).toThrow();
    expect(() =>
      db.query("update agents set effort = 'extreme'").run(),
    ).toThrow();
    db.close();
  });

  test("a user starts enabled with an unforced password and a unique email", () => {
    const db = seed();
    expect(
      db
        .query(
          "select disabled, must_change_password from users where id = 'u'",
        )
        .get(),
    ).toEqual({ disabled: 0, must_change_password: 0 });
    expect(() =>
      db
        .query(
          `insert into users (id, username, full_name, email, role, password_hash, created_at)
           values ('v', 'other', 'Other', 'user@example.com', 'member', 'x', 0)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .query(
          `insert into users (id, username, full_name, role, password_hash, created_at)
           values ('w', 'noemail', 'No Email', 'member', 'x', 0)`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  test("a project starts with an empty description", () => {
    const db = seed();
    expect(
      db.query("select name, description from projects where id = 'p'").get(),
    ).toEqual({ name: "personal", description: "" });
    db.close();
  });
});
