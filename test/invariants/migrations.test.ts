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

describe("0003-tools", () => {
  // a populated 0001 db with two sends in one session and one in
  // another migrates through 0002 and 0003: every message is placed in
  // its send, defaults land, and the rebuilt constraints stay intact.
  function seed() {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, [MIGRATIONS[0]]);
    db.exec(`
      insert into users (id, username, full_name, role, password_hash, created_at)
        values ('u', 'user', 'User', 'member', 'x', 0);
      insert into projects (id, kind, name, owner_id, created_at)
        values ('p', 'personal', 'user', 'u', 0);
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr', 'prov', 'openai-compatible', 'http://x', 0);
      insert into agents (id, name, provider_id, model, model_name, created_at)
        values ('a', 'agent', 'pr', 'm', 'M', 0);
      insert into sessions (id, project_id, owner_id, agent_id, origin, title, status, revision, created_at, last_activity_at)
        values ('sess', 'p', 'u', 'a', 'chat', 'chat', 'done', 3, 0, 0);
      insert into sessions (id, project_id, owner_id, agent_id, origin, title, status, revision, created_at, last_activity_at)
        values ('sess2', 'p', 'u', 'a', 'chat', 'two', 'done', 1, 0, 0);
    `);
    // session sess: two sends. send1 (user m1, reply m2 done), send2
    // (user m3, reply m4 done). session sess2: send3 (user m5, reply m6)
    const insSend = db.query(
      `insert into sends (id, session_id, kind, user_id, agent_id, provider_id, model, status, first_message_id, started_at)
       values (?, ?, 'chat', 'u', 'a', 'pr', 'm', 'done', ?, ?)`,
    );
    insSend.run("send1", "sess", "m1", 0);
    insSend.run("send2", "sess", "m3", 10);
    insSend.run("send3", "sess2", "m5", 0);
    const insUser = db.query(
      `insert into messages (id, session_id, seq, kind, user_id, content, status, created_at, finished_at)
       values (?, ?, ?, 'user', 'u', 'q', 'done', ?, ?)`,
    );
    const insReply = db.query(
      `insert into messages (id, session_id, seq, kind, agent_id, model, content, html, status, finish_reason, created_at, finished_at)
       values (?, ?, ?, 'reply', 'a', 'm', 'ans', 'ans', 'done', 'stop', ?, ?)`,
    );
    insUser.run("m1", "sess", 1, 0, 0);
    insReply.run("m2", "sess", 2, 0, 1);
    insUser.run("m3", "sess", 3, 10, 10);
    insReply.run("m4", "sess", 4, 10, 11);
    insUser.run("m5", "sess2", 1, 0, 0);
    insReply.run("m6", "sess2", 2, 0, 1);
    // a usage row per send, so the (send, round) unique has data
    const insUsage = db.query(
      `insert into usage (id, send_id, session_id, project_id, user_id, agent_id, provider_id, model, round, prompt_tokens, completion_tokens, created_at)
       values (?, ?, ?, 'p', 'u', 'a', 'pr', 'm', 1, 1, 1, 0)`,
    );
    insUsage.run("us1", "send1", "sess");
    insUsage.run("us2", "send2", "sess");
    insUsage.run("us3", "send3", "sess2");
    return db;
  }

  test("places every message in its send and lands the defaults", () => {
    const db = seed();
    migrate(db);
    const rows = db
      .query<
        {
          id: string;
          send_id: string;
          round: number;
          slot: string | null;
          kind: string;
        },
        []
      >(
        "select id, send_id, round, slot, kind from messages order by session_id, seq",
      )
      .all();
    expect(rows).toEqual([
      { id: "m1", send_id: "send1", round: 1, slot: null, kind: "user" },
      { id: "m2", send_id: "send1", round: 1, slot: "answer", kind: "reply" },
      { id: "m3", send_id: "send2", round: 1, slot: null, kind: "user" },
      { id: "m4", send_id: "send2", round: 1, slot: "answer", kind: "reply" },
      { id: "m5", send_id: "send3", round: 1, slot: null, kind: "user" },
      { id: "m6", send_id: "send3", round: 1, slot: "answer", kind: "reply" },
    ]);
    // the send counters default
    expect(
      db.query("select rounds, tool_calls from sends where id = 'send1'").get(),
    ).toEqual({ rounds: 1, tool_calls: 0 });
    db.close();
  });

  test("the uniques, cascade and foreign keys hold after the rebuild", () => {
    const db = seed();
    migrate(db);
    // the new tool row shape is accepted; a bad shape is rejected
    const insTool = db.query(
      `insert into messages (id, session_id, seq, kind, send_id, round, tool_call_id, tool_name, status, created_at)
       values (?, 'sess', ?, 'tool', 'send1', 1, ?, ?, 'streaming', 0)`,
    );
    insTool.run("t1", 5, "c1", "webfetch");
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
          `insert into usage (id, send_id, session_id, project_id, user_id, agent_id, provider_id, model, round, prompt_tokens, completion_tokens, created_at, seq)
           values ('dup', 'send1', 'sess', 'p', 'u', 'a', 'pr', 'm', 1, 1, 1, 0, 9)`,
        )
        .run(),
    ).toThrow();
    // the cascade: deleting the session takes its messages
    db.query("delete from sessions where id = 'sess'").run();
    expect(
      db
        .query("select count(*) as n from messages where session_id = 'sess'")
        .get(),
    ).toEqual({ n: 0 });
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("a user row that did not start a send fails the migration", () => {
    const db = new Database(":memory:");
    migrate(db, [MIGRATIONS[0], MIGRATIONS[1]]);
    db.exec(`
      insert into users (id, username, full_name, role, password_hash, created_at)
        values ('u', 'user', 'User', 'member', 'x', 0);
      insert into projects (id, kind, name, owner_id, created_at)
        values ('p', 'personal', 'user', 'u', 0);
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr', 'prov', 'openai-compatible', 'http://x', 0);
      insert into agents (id, name, provider_id, model, model_name, created_at)
        values ('a', 'agent', 'pr', 'm', 'M', 0);
      insert into sessions (id, project_id, owner_id, agent_id, origin, title, status, revision, created_at, last_activity_at)
        values ('sess', 'p', 'u', 'a', 'chat', 'chat', 'done', 0, 0, 0);
      insert into sends (id, session_id, kind, user_id, agent_id, provider_id, model, status, first_message_id, started_at)
        values ('send1', 'sess', 'chat', 'u', 'a', 'pr', 'm', 'done', 'm1', 0);
      insert into messages (id, session_id, seq, kind, user_id, content, status, created_at, finished_at)
        values ('m1', 'sess', 1, 'user', 'u', 'q1', 'done', 0, 0);
      insert into messages (id, session_id, seq, kind, agent_id, model, content, status, created_at, finished_at)
        values ('m2', 'sess', 2, 'reply', 'a', 'm', 'a1', 'done', 0, 1);
      insert into messages (id, session_id, seq, kind, user_id, content, status, created_at, finished_at)
        values ('orphan', 'sess', 3, 'user', 'u', 'q2', 'done', 2, 2);
    `);
    expect(() => migrate(db)).toThrow("matched no send");
    // the failed migration left no trace
    expect(
      db
        .query("select count(*) as n from migrations where id = '0003-tools'")
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  test("foreign_key_check refuses violations after the rebuild", () => {
    const db = new Database(":memory:");
    migrate(db, [MIGRATIONS[0], MIGRATIONS[1]]);
    db.exec("pragma foreign_keys = off");
    db.exec(`
      insert into users (id, username, full_name, role, password_hash, created_at)
        values ('u', 'user', 'User', 'member', 'x', 0);
      insert into projects (id, kind, name, owner_id, created_at)
        values ('p', 'personal', 'user', 'u', 0);
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr', 'prov', 'openai-compatible', 'http://x', 0);
      insert into agents (id, name, provider_id, model, model_name, created_at)
        values ('a', 'agent', 'pr', 'm', 'M', 0);
      insert into sessions (id, project_id, owner_id, agent_id, origin, title, status, revision, created_at, last_activity_at)
        values ('sess', 'p', 'u', 'a', 'chat', 'chat', 'done', 0, 0, 0);
      insert into sends (id, session_id, kind, user_id, agent_id, provider_id, model, status, first_message_id, started_at)
        values ('bad', 'sess', 'chat', 'u', 'a', 'missing', 'm', 'done', 'none', 0);
    `);

    expect(() => migrate(db)).toThrow("foreign key check found 1 violations");
    expect(
      db
        .query("select count(*) as n from migrations where id = '0003-tools'")
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});
