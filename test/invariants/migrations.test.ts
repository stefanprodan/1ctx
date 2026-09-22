// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fresh file gets every migration once; a reopen applies none; the
// list has unique, ordered ids.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, open } from "../../src/server/db/index.ts";
import { MIGRATIONS } from "../../src/server/db/migrations/index.ts";
import { EFFORTS, WIRES } from "../../src/shared/words.ts";
import { fileDb } from "../helpers/db.ts";

describe("migrations", () => {
  test("ids are unique and ordered", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^\d{4}-[a-z0-9-]+$/);
  });

  test("a fresh file gets them all and a reopen gets none", () => {
    const { db, path, migrations, cleanup } = fileDb();
    try {
      expect(migrations).toEqual(MIGRATIONS.map((migration) => migration.id));
      const applied = db
        .query<{ id: string }, []>("select id from migrations order by id")
        .all()
        .map((r) => r.id);
      expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
      db.close();
      const { db: again, migrations: reopenedMigrations } = open(path);
      expect(reopenedMigrations).toEqual([]);
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
  function seed(migrations = MIGRATIONS) {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, migrations);
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

  test("0018 defaults existing sessions and automations to an empty set without losing rows", () => {
    const db = seed(MIGRATIONS.slice(0, 17));
    try {
      db.exec(`
        insert into automations
          (id, project_id, owner_id, agent_id, name, instructions, schedule,
           tz, retention_days, next_at, created_at, updated_at)
          values ('auto', 'p', 'u', 'a', 'daily', 'check', '0 9 * * *',
            'UTC', 30, 1000, 0, 0);
      `);
      const tables = [
        "users",
        "projects",
        "providers",
        "agents",
        "sessions",
        "automations",
        "messages",
        "sends",
        "usage",
      ];
      const before = tables.map((name) =>
        db
          .query<Record<string, unknown>, []>(
            `select * from ${name} order by id`,
          )
          .all(),
      );
      expect(migrate(db, MIGRATIONS.slice(0, 18))).toEqual(["0018-web-access"]);
      expect(
        tables.map((name) =>
          db.query(`select * from ${name} order by id`).all(),
        ),
      ).toEqual(
        before.map((rows, index) =>
          ["sessions", "automations"].includes(tables[index]!)
            ? rows.map((row) => ({ ...row, disabled_capabilities: "[]" }))
            : rows,
        ),
      );
      for (const table of ["sessions", "automations"]) {
        expect(() =>
          db.query(`update ${table} set disabled_capabilities = null`).run(),
        ).toThrow();
      }
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      expect(db.query("pragma foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      db.close();
    }
  });

  test("0012 adds nullable fork source ids without references or a rebuild", () => {
    const db = seed(MIGRATIONS.slice(0, 11));
    try {
      const session = db
        .query<Record<string, string | number | null>, []>(
          "select * from sessions",
        )
        .get();
      const messages = db.query("select * from messages order by seq").all();
      const sends = db.query("select * from sends order by id").all();
      expect(migrate(db, MIGRATIONS.slice(0, 12))).toEqual(["0012-fork"]);
      expect(MIGRATIONS[11]?.rebuild).toBeUndefined();
      expect(db.query("select * from sessions").get()).toEqual({
        ...session,
        forked_from_session_id: null,
        forked_from_message_id: null,
      });
      expect(db.query("select * from messages order by seq").all()).toEqual(
        messages,
      );
      expect(db.query("select * from sends order by id").all()).toEqual(sends);
      const columns = db
        .query<{ name: string; type: string; notnull: number }, []>(
          "pragma table_info(sessions)",
        )
        .all();
      const foreignKeys = db
        .query<{ from: string }, []>("pragma foreign_key_list(sessions)")
        .all();
      for (const name of ["forked_from_session_id", "forked_from_message_id"]) {
        expect(columns.find((column) => column.name === name)).toMatchObject({
          type: "TEXT",
          notnull: 0,
        });
        expect(foreignKeys.some((key) => key.from === name)).toBe(false);
      }
      db.exec(`
        update sessions set forked_from_session_id = 'deleted-session',
          forked_from_message_id = 'deleted-message';
      `);
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      expect(migrate(db, MIGRATIONS.slice(0, 12))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("0015 adds knowledge and keeps history after a file is deleted", () => {
    const db = seed(MIGRATIONS.slice(0, 14));
    try {
      const tables = ["users", "projects", "sessions", "messages", "sends"];
      const before = tables.map((name) =>
        db
          .query<Record<string, unknown>, []>(
            `select * from ${name} order by id`,
          )
          .all(),
      );
      expect(migrate(db, MIGRATIONS.slice(0, 17))).toEqual([
        "0015-knowledge",
        "0016-openai-strict",
        "0017-chat-uploads",
      ]);
      expect(MIGRATIONS[14]?.rebuild).toBeUndefined();
      expect(
        tables.map((name) =>
          db.query(`select * from ${name} order by id`).all(),
        ),
      ).toEqual(
        before.map((rows, index) =>
          tables[index] === "messages"
            ? rows.map((row) => ({ ...row, uploads: null }))
            : rows,
        ),
      );
      const fileColumns = db
        .query<{ name: string }, []>("pragma table_info(knowledge_files)")
        .all()
        .map((row) => row.name);
      expect(fileColumns).toEqual([
        "id",
        "project_id",
        "name",
        "kind",
        "text",
        "bytes",
        "lines",
        "digest",
        "tokens",
        "revision",
        "author_kind",
        "author_id",
        "author_name",
        "session_id",
        "origin",
        "created_at",
        "updated_at",
      ]);
      expect(
        db
          .query<{ from: string }, []>(
            "pragma foreign_key_list(knowledge_versions)",
          )
          .all()
          .map((row) => row.from),
      ).toEqual(["project_id"]);
      db.exec(`
        insert into knowledge_files values (
          'f', 'p', 'docs/x.md', 'md', 'hello', 5, 1, 'digest', 1, 1,
          'agent', 'gone-agent', 'writer', 'gone-session', 'chat', 1, 1
        );
        insert into knowledge_versions values (
          'v', 'f', 'p', 'docs/x.md', 1, 'hello', 5, 1,
          'agent', 'gone-agent', 'writer', 'gone-session', 'automation', 1,
          0, null
        );
      `);
      for (const table of ["knowledge_files", "knowledge_versions"]) {
        expect(() =>
          db.query(`update ${table} set author_kind = 'other'`).run(),
        ).toThrow();
        expect(() =>
          db.query(`update ${table} set origin = 'other'`).run(),
        ).toThrow();
        db.query(
          `update ${table} set author_kind = 'user', origin = null`,
        ).run();
      }
      expect(() =>
        db.query("update knowledge_versions set deleted = 2").run(),
      ).toThrow();
      expect(() =>
        db
          .query(
            "insert into knowledge_files select 'other', project_id, name, kind, text, bytes, lines, digest, tokens, revision, author_kind, author_id, author_name, session_id, origin, created_at, updated_at from knowledge_files",
          )
          .run(),
      ).toThrow();
      const indexes = db
        .query<{ name: string }, []>(
          "select name from sqlite_master where type = 'index'",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toContain("knowledge_versions_file");
      expect(indexes).toContain("knowledge_versions_project");
      db.exec("delete from knowledge_files");
      expect(db.query("select text from knowledge_versions").get()).toEqual({
        text: "hello",
      });
      db.exec("delete from projects where id = 'p'");
      expect(db.query("select * from knowledge_versions").all()).toEqual([]);
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      expect(db.query("pragma foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(migrate(db, MIGRATIONS.slice(0, 17))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("0017 adds ordered upload storage and nullable message records without a rebuild", () => {
    const db = seed(MIGRATIONS.slice(0, 16));
    try {
      db.exec(`
        insert into knowledge_files values (
          'f', 'p', 'docs/x.md', 'md', 'hello', 5, 1, 'digest', 1, 1,
          'user', 'u', 'user', null, null, 1, 1
        );
        insert into knowledge_versions values (
          'v', 'f', 'p', 'docs/x.md', 1, 'hello', 5, 1,
          'user', 'u', 'user', null, null, 1, 0, null
        );
        insert into session_scratch values ('sess', '/tmp/work', 2, 3, 1, 7);
        insert into session_scratch_files
          values ('sess', 'work/data.bin', x'00ff01', 384);
      `);
      const tables = [
        "users",
        "projects",
        "providers",
        "agents",
        "sessions",
        "sends",
        "usage",
        "knowledge_files",
        "knowledge_versions",
        "session_scratch",
        "session_scratch_files",
      ];
      const before = tables.map((table) =>
        db.query(`select * from ${table} order by rowid`).all(),
      );
      const messages = db
        .query<Record<string, unknown>, []>(
          "select * from messages order by seq",
        )
        .all();
      expect(migrate(db, MIGRATIONS.slice(0, 17))).toEqual([
        "0017-chat-uploads",
      ]);
      expect(MIGRATIONS[16]?.rebuild).toBeUndefined();
      expect(
        tables.map((table) =>
          db.query(`select * from ${table} order by rowid`).all(),
        ),
      ).toEqual(before);
      expect(db.query("select * from messages order by seq").all()).toEqual(
        messages.map((message) => ({ ...message, uploads: null })),
      );
      for (const table of [
        "upload_staged",
        "upload_staged_files",
        "session_uploads",
        "session_upload_files",
      ]) {
        expect(db.query(`select * from ${table}`).all()).toEqual([]);
      }
      expect(db.query("pragma table_info(messages)").all()).toContainEqual(
        expect.objectContaining({
          name: "uploads",
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
        }),
      );
      expect(
        db
          .query<{ from: string }, []>("pragma foreign_key_list(messages)")
          .all()
          .some((key) => key.from === "uploads"),
      ).toBeFalse();
      const record = JSON.stringify([
        {
          name: "notes.zip",
          archive: true,
          files: 1,
          bytes: 5,
          saved: ["notes/a.md"],
        },
      ]);
      db.query("update messages set uploads = ? where id = 'm1'").run(record);
      db.exec(`
        insert into upload_staged values
          ('staged', 'u', 'p', 'attempt', 'notes.zip', 1, 1, 5, '{}', 0, 100);
        insert into upload_staged_files values
          ('staged', 0, 'notes/a.md', 'hello', 5);
        insert into session_uploads values ('sess', 1, 5, 1);
        insert into session_upload_files
          (session_id, name, text, bytes, message_id, item, archive, folder, created_at)
          values ('sess', 'notes/a.md', 'hello', 5, 'gone-message', 'notes.zip', 1, 'notes', 1);
      `);
      expect(
        db
          .query<{ from: string }, []>(
            "pragma foreign_key_list(session_upload_files)",
          )
          .all()
          .map((key) => key.from),
      ).toEqual(["session_id"]);
      expect(() =>
        db.query("update upload_staged set archive = 2").run(),
      ).toThrow();
      expect(() =>
        db.query("update session_upload_files set archive = 2").run(),
      ).toThrow();
      expect(() =>
        db
          .query(
            `insert into upload_staged
             select 'duplicate', user_id, project_id, attempt, name, archive,
                    files, bytes, result, created_at, expires_at
             from upload_staged`,
          )
          .run(),
      ).toThrow();
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      expect(db.query("pragma foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(migrate(db, MIGRATIONS.slice(0, 17))).toEqual([]);
      expect(
        db.query("select uploads from messages where id = 'm1'").get(),
      ).toEqual({ uploads: record });
      expect(
        db.query("select * from session_upload_files").get(),
      ).toMatchObject({
        text: "hello",
        folder: "notes",
        item_index: 0,
        position: 0,
      });
      const columns = db.query("pragma table_info(session_upload_files)").all();
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "folder", type: "TEXT", notnull: 1 }),
      );
      expect(() =>
        db.query("update session_upload_files set folder = null").run(),
      ).toThrow();
      for (const name of ["item_index", "position"]) {
        expect(columns).toContainEqual(
          expect.objectContaining({
            name,
            type: "INTEGER",
            notnull: 1,
            dflt_value: "0",
          }),
        );
        expect(() =>
          db.query(`update session_upload_files set ${name} = null`).run(),
        ).toThrow();
        expect(() =>
          db.query(`update session_upload_files set ${name} = -1`).run(),
        ).toThrow();
      }
      db.exec("update session_upload_files set item_index = 2, position = 3");
      expect(
        db.query("select item_index, position from session_upload_files").get(),
      ).toEqual({ item_index: 2, position: 3 });
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      expect(db.query("pragma foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(migrate(db, MIGRATIONS.slice(0, 17))).toEqual([]);
      db.exec("delete from sessions where id = 'sess'");
      expect(db.query("select * from session_upload_files").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("0019 adds ordered opened copies that cascade with messages", () => {
    const db = seed(MIGRATIONS.slice(0, 18));
    try {
      const before = db.query("select * from messages order by seq").all();
      expect(migrate(db)).toEqual(["0019-open"]);
      expect(db.query("select * from messages order by seq").all()).toEqual(
        before,
      );
      expect(MIGRATIONS[18]?.rebuild).toBeUndefined();
      expect(
        db
          .query<{ name: string }, []>("pragma table_info(opened_files)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "message_id",
        "position",
        "path",
        "kind",
        "language",
        "bytes",
        "lines",
        "title",
        "text",
      ]);
      expect(
        db
          .query<{ from: string; on_delete: string }, []>(
            "pragma foreign_key_list(opened_files)",
          )
          .get(),
      ).toMatchObject({ from: "message_id", on_delete: "CASCADE" });
      db.exec(`
        insert into opened_files values
          ('m2', 0, '/tmp/a.html', 'visual', null, 8, 1, 'A', '<p>A</p>'),
          ('m2', 1, '/tmp/a.md', 'markdown', null, 3, 1, null, '# A');
      `);
      expect(() =>
        db.query("update opened_files set position = -1").run(),
      ).toThrow();
      expect(() =>
        db.query("update opened_files set kind = 'image'").run(),
      ).toThrow();
      expect(() =>
        db
          .query(
            "insert into opened_files select message_id, 0, path, kind, language, bytes, lines, title, text from opened_files where position = 1",
          )
          .run(),
      ).toThrow();
      db.query("delete from messages where id = 'm2'").run();
      expect(db.query("select * from opened_files").all()).toEqual([]);
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      expect(db.query("pragma foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      db.close();
    }
  });

  test("a provider accepts every known wire and refuses anything else", () => {
    const db = seed();
    try {
      for (const wire of WIRES) {
        db.query("update providers set wire = ? where id = 'pr'").run(wire);
        expect(
          db.query("select wire from providers where id = 'pr'").get(),
        ).toEqual({ wire });
      }
      expect(() =>
        db.query("update providers set wire = 'unknown'").run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

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

  test("the web tools start enabled and limits start empty", () => {
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
      { name: "webfetch", enabled: 1, provider: null, updated_at: 0 },
      { name: "websearch", enabled: 1, provider: null, updated_at: 0 },
      { name: "visualize", enabled: 1, provider: null, updated_at: 0 },
      { name: "web", enabled: 1, provider: null, updated_at: 0 },
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

describe("additive migrations", () => {
  test("0004 adds run_source and preserves existing sessions", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 3));
    db.exec(`
      insert into users
        (id, username, full_name, email, role, password_hash, created_at)
        values ('u4', 'user4', 'User', 'user4@example.com', 'member', 'x', 0);
      insert into projects (id, kind, name, owner_id, created_at)
        values ('p4', 'personal', 'personal', 'u4', 0);
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr4', 'prov4', 'openai-compatible', 'http://x', 0);
      insert into agents
        (id, name, provider_id, model, model_name, created_at)
        values ('a4', 'agent4', 'pr4', 'm', 'M', 0);
      insert into automations
        (id, project_id, owner_id, agent_id, name, instructions, schedule, tz,
         retention_days, next_at, created_at, updated_at)
        values ('au4', 'p4', 'u4', 'a4', 'daily', 'check', '0 9 * * *',
                'UTC', 30, 1, 0, 0);
      insert into sessions
        (id, project_id, owner_id, agent_id, origin, automation_id, title,
         status, revision, created_at, last_activity_at)
        values ('chat4', 'p4', 'u4', 'a4', 'chat', null, 'chat', 'done', 1, 0, 1),
               ('run4', 'p4', 'u4', 'a4', 'automation', 'au4', 'daily',
                'done', 1, 0, 1);
    `);

    expect(migrate(db)).toEqual([
      "0004-run-source",
      "0005-suspended-by",
      "0006-skills",
      "0007-user-tz",
      "0008-search-tavily",
      "0009-mcp",
      "0010-memory",
      "0011-gemini",
      "0012-fork",
      "0013-web-tools",
      "0014-visualize",
      "0015-knowledge",
      "0016-openai-strict",
      "0017-chat-uploads",
      "0018-web-access",
      "0019-open",
    ]);
    expect(
      db.query("select id, run_source from sessions order by id").all(),
    ).toEqual([
      { id: "chat4", run_source: null },
      { id: "run4", run_source: null },
    ]);
    db.query(
      "update sessions set run_source = 'manual' where id = 'run4'",
    ).run();
    expect(() =>
      db.query("update sessions set run_source = 'other'").run(),
    ).toThrow();
    db.close();
  });
});

describe("0005", () => {
  test("adds suspended_by and keeps a suspended row's time", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 4));
    db.exec(`
      insert into users
        (id, username, full_name, email, role, password_hash, created_at)
        values ('u5', 'user5', 'User', 'user5@example.com', 'member', 'x', 0);
      insert into projects (id, kind, name, owner_id, created_at)
        values ('p5', 'personal', 'personal', 'u5', 0);
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr5', 'prov5', 'openai-compatible', 'http://x', 0);
      insert into agents
        (id, name, provider_id, model, model_name, created_at)
        values ('a5', 'agent5', 'pr5', 'm', 'M', 0);
      insert into automations
        (id, project_id, owner_id, agent_id, name, instructions, schedule, tz,
         retention_days, suspended_at, next_at, created_at, updated_at)
        values ('au5', 'p5', 'u5', 'a5', 'daily', 'check', '0 9 * * *',
                'UTC', 30, 7, null, 0, 0);
    `);
    expect(migrate(db)).toEqual([
      "0005-suspended-by",
      "0006-skills",
      "0007-user-tz",
      "0008-search-tavily",
      "0009-mcp",
      "0010-memory",
      "0011-gemini",
      "0012-fork",
      "0013-web-tools",
      "0014-visualize",
      "0015-knowledge",
      "0016-openai-strict",
      "0017-chat-uploads",
      "0018-web-access",
      "0019-open",
    ]);
    expect(
      db.query("select suspended_at, suspended_by from automations").get(),
    ).toEqual({ suspended_at: 7, suspended_by: null });
    expect(() =>
      db.query("update automations set suspended_by = 'nobody'").run(),
    ).toThrow();
    db.close();
  });
});

describe("rebuild migrations", () => {
  test("0003 preserves chat rows and recreates the indexes", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 2));
    db.exec(`
      insert into users
        (id, username, full_name, email, role, password_hash, created_at)
        values ('u3', 'user3', 'User', 'user3@example.com', 'member', 'x', 0);
      insert into projects (id, kind, name, owner_id, created_at)
        values ('p3', 'personal', 'personal', 'u3', 0);
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr3', 'prov3', 'openai-compatible', 'http://x', 0);
      insert into agents
        (id, name, provider_id, model, model_name, created_at)
        values ('a3', 'agent3', 'pr3', 'm', 'M', 0);
      insert into sessions
        (id, project_id, owner_id, agent_id, origin, title, status,
         revision, created_at, last_activity_at)
        values ('s3', 'p3', 'u3', 'a3', 'chat', 'chat', 'done', 1, 0, 1);
      insert into sends
        (id, session_id, kind, user_id, agent_id, provider_id, model,
         status, first_message_id, started_at)
        values ('d3', 's3', 'chat', 'u3', 'a3', 'pr3', 'm', 'done', 'm3', 0);
      insert into messages
        (id, session_id, seq, kind, send_id, round, user_id, content,
         status, created_at, finished_at)
        values ('m3', 's3', 1, 'user', 'd3', 1, 'u3', 'hello', 'done', 0, 0);
      insert into usage
        (id, send_id, session_id, project_id, user_id, agent_id,
         provider_id, model, round, seq, prompt_tokens, completion_tokens,
         created_at)
        values ('z3', 'd3', 's3', 'p3', 'u3', 'a3', 'pr3', 'm', 1, 1, 1, 1, 0);
    `);

    expect(migrate(db)).toEqual([
      "0003-automations",
      "0004-run-source",
      "0005-suspended-by",
      "0006-skills",
      "0007-user-tz",
      "0008-search-tavily",
      "0009-mcp",
      "0010-memory",
      "0011-gemini",
      "0012-fork",
      "0013-web-tools",
      "0014-visualize",
      "0015-knowledge",
      "0016-openai-strict",
      "0017-chat-uploads",
      "0018-web-access",
      "0019-open",
    ]);
    expect(
      db.query("select origin, automation_id from sessions").get(),
    ).toEqual({
      origin: "chat",
      automation_id: null,
    });
    expect(db.query("select kind from sends").get()).toEqual({ kind: "chat" });
    expect(db.query("select content from messages").get()).toEqual({
      content: "hello",
    });
    expect(db.query("select prompt_tokens from usage").get()).toEqual({
      prompt_tokens: 1,
    });
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    expect(db.query("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    const indexes = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'index'",
      )
      .all()
      .map((row) => row.name);
    for (const name of [
      "sessions_project",
      "sessions_agent",
      "sessions_automation",
      "sends_session",
      "messages_answer",
      "messages_streaming_reply",
      "usage_session",
      "usage_send_round",
      "usage_activity",
    ]) {
      expect(indexes).toContain(name);
    }
    db.close();
  });

  test("foreign keys return after a rebuild check fails", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    expect(() =>
      migrate(db, [
        {
          id: "9999-bad-rebuild",
          rebuild: true,
          up(d) {
            d.exec(`
              create table rebuild_parent (id text primary key);
              create table rebuild_child (
                parent_id text references rebuild_parent(id)
              );
              insert into rebuild_child values ('missing');
            `);
          },
        },
      ]),
    ).toThrow("foreign key check failed");
    expect(db.query("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(
      db
        .query(
          "select count(*) as n from sqlite_master where name = 'rebuild_child'",
        )
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});

describe("0006 skills migration", () => {
  test("adds the skills tables without changing existing rows", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 5));
    db.exec(`
      insert into providers (id, name, wire, base_url, created_at)
        values ('pr6', 'prov6', 'openai-compatible', 'http://x', 0);
      insert into agents
        (id, name, provider_id, model, model_name, created_at)
        values ('a6', 'agent6', 'pr6', 'm', 'Model', 0);
    `);
    expect(migrate(db)).toEqual([
      "0006-skills",
      "0007-user-tz",
      "0008-search-tavily",
      "0009-mcp",
      "0010-memory",
      "0011-gemini",
      "0012-fork",
      "0013-web-tools",
      "0014-visualize",
      "0015-knowledge",
      "0016-openai-strict",
      "0017-chat-uploads",
      "0018-web-access",
      "0019-open",
    ]);
    expect(db.query("select name from agents where id = 'a6'").get()).toEqual({
      name: "agent6",
    });
    db.exec(`
      insert into skills
        (id, name, description, body, license, compatibility, metadata,
         allowed_tools, source_kind, source_url, source_select, source_digest,
         digest, dropped, fetched_at, created_at)
        values
        ('sk6', 'ops', 'ops', 'body', '', '', '{}', '', 'file',
         'http://x/skill.md', '', '', 'd', '[]', 0, 0);
      insert into skill_files (skill_id, path, content, bytes)
        values ('sk6', 'references/a.md', 'a', 1);
      insert into agent_skills (agent_id, skill_id) values ('a6', 'sk6');
    `);
    expect(() =>
      db.query("delete from skills where id = 'sk6'").run(),
    ).toThrow();
    db.query("delete from agents where id = 'a6'").run();
    expect(db.query("select count(*) as n from agent_skills").get()).toEqual({
      n: 0,
    });
    db.query("delete from skills where id = 'sk6'").run();
    expect(db.query("select count(*) as n from skill_files").get()).toEqual({
      n: 0,
    });
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    db.close();
  });
});

describe("0007 user tz migration", () => {
  test("puts every existing user in UTC", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 6));
    db.exec(`
      insert into users
        (id, username, full_name, email, role, password_hash, created_at)
        values ('u7', 'user7', 'User', 'u7@example.com', 'member', 'h', 0);
    `);
    expect(migrate(db)).toEqual([
      "0007-user-tz",
      "0008-search-tavily",
      "0009-mcp",
      "0010-memory",
      "0011-gemini",
      "0012-fork",
      "0013-web-tools",
      "0014-visualize",
      "0015-knowledge",
      "0016-openai-strict",
      "0017-chat-uploads",
      "0018-web-access",
      "0019-open",
    ]);
    expect(db.query("select tz from users where id = 'u7'").get()).toEqual({
      tz: "UTC",
    });
    db.close();
  });
});

describe("0009 mcp migration", () => {
  test("keeps the agents and sends, adds the mode and the digest key", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 8));
    db.exec(`
      insert into users
        (id, username, full_name, email, tz, role, password_hash, created_at)
        values ('u9', 'user9', 'User', 'u9@example.com', 'UTC', 'admin', 'h', 0);
      insert into providers (id, name, wire, base_url, key_name, created_at)
        values ('p9', 'prov9', 'openai-compatible', 'http://x', null, 0);
      insert into agents
        (id, name, provider_id, model, model_name, created_at)
        values ('a9', 'agent9', 'p9', 'm', 'M', 0);
    `);
    expect(migrate(db)).toEqual([
      "0009-mcp",
      "0010-memory",
      "0011-gemini",
      "0012-fork",
      "0013-web-tools",
      "0014-visualize",
      "0015-knowledge",
      "0016-openai-strict",
      "0017-chat-uploads",
      "0018-web-access",
      "0019-open",
    ]);
    expect(
      db.query("select mcp_mode from agents where id = 'a9'").get(),
    ).toEqual({ mcp_mode: "auto" });
    expect(() =>
      db.query("update agents set mcp_mode = 'other' where id = 'a9'").run(),
    ).toThrow();
    db.query("update agents set mcp_mode = 'catalog' where id = 'a9'").run();
    db.exec(`
      insert into mcp_servers
        (id, name, url, read, write, read_patterns, write_patterns,
         excluded_patterns, server_name, server_version, protocol_version,
         instructions, fingerprint, checked_at, created_at)
        values ('s9', 'flux', 'http://x/mcp', 1, 0, '[]', '[]', '[]',
                '', '', '2025-06-18', '', 'f', 0, 0);
      insert into agent_servers (agent_id, server_id, read, write)
        values ('a9', 's9', 1, 0);
    `);
    // at least one side on
    expect(() =>
      db.query("update agent_servers set read = 0 where agent_id = 'a9'").run(),
    ).toThrow();
    // a server an agent references stays
    expect(() =>
      db.query("delete from mcp_servers where id = 's9'").run(),
    ).toThrow();
    // an agent's rows go with it
    db.query("delete from agents where id = 'a9'").run();
    expect(db.query("select count(*) as n from agent_servers").get()).toEqual({
      n: 0,
    });
    db.close();
  });
});

describe("0013 web tools migration", () => {
  test("drops the datetime row, keeps the web rows and refuses datetime", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 12));
    db.exec(`
      update tools set enabled = 0, updated_at = 4 where name = 'datetime';
      update tools set enabled = 0, updated_at = 5 where name = 'webfetch';
      update tools set provider = 'tavily', updated_at = 6
        where name = 'websearch';
    `);
    expect(migrate(db, MIGRATIONS.slice(0, 13))).toEqual(["0013-web-tools"]);
    expect(MIGRATIONS[12]?.rebuild).toBeUndefined();
    expect(
      db
        .query(
          "select name, enabled, provider, updated_at from tools order by rowid",
        )
        .all(),
    ).toEqual([
      { name: "webfetch", enabled: 0, provider: null, updated_at: 5 },
      { name: "websearch", enabled: 1, provider: "tavily", updated_at: 6 },
    ]);
    expect(() =>
      db
        .query(
          "insert into tools (name, enabled, updated_at) values ('datetime', 1, 0)",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe("0014 visualize migration", () => {
  test("preserves web settings and row order, adds the enabled visual and its hosts", () => {
    const db = new Database(":memory:");
    try {
      db.exec("pragma foreign_keys = on");
      migrate(db, MIGRATIONS.slice(0, 13));
      db.exec(`
        update tools set enabled = 0, updated_at = 5 where name = 'webfetch';
        update tools set provider = 'tavily', updated_at = 6 where name = 'websearch';
        update tools set rowid = 10 where name = 'webfetch';
      `);
      const before = db
        .query<Record<string, string | number | null>, []>(
          "select * from tools order by rowid",
        )
        .all();
      expect(migrate(db, MIGRATIONS.slice(0, 14))).toEqual(["0014-visualize"]);
      expect(MIGRATIONS[13]?.rebuild).toBeUndefined();
      const rows = db.query("select * from tools order by rowid").all();
      expect(rows.slice(0, 2)).toEqual(
        before.map((row) => ({
          ...row,
          hosts: "[]",
        })),
      );
      expect(rows[2]).toEqual({
        name: "visualize",
        enabled: 1,
        provider: null,
        hosts: JSON.stringify([
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
          "https://esm.sh",
          "https://unpkg.com",
        ]),
        updated_at: 0,
      });
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      expect(db.query("pragma foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(migrate(db, MIGRATIONS.slice(0, 14))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("0008 search tavily migration", () => {
  test("keeps the tool rows and accepts tavily", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    migrate(db, MIGRATIONS.slice(0, 7));
    db.exec(`
      update tools set enabled = 0, updated_at = 5 where name = 'webfetch';
      update tools set provider = 'firecrawl', updated_at = 6
        where name = 'websearch';
    `);
    expect(migrate(db, MIGRATIONS.slice(0, 8))).toEqual(["0008-search-tavily"]);
    expect(
      db
        .query(
          "select name, enabled, provider, updated_at from tools order by rowid",
        )
        .all(),
    ).toEqual([
      { name: "datetime", enabled: 1, provider: null, updated_at: 0 },
      { name: "webfetch", enabled: 0, provider: null, updated_at: 5 },
      { name: "websearch", enabled: 1, provider: "firecrawl", updated_at: 6 },
    ]);
    db.query(
      "update tools set provider = 'tavily' where name = 'websearch'",
    ).run();
    expect(() =>
      db
        .query("update tools set provider = 'other' where name = 'websearch'")
        .run(),
    ).toThrow();
    db.close();
  });

  describe("0011 Gemini migration", () => {
    test("widens the wire check and keeps providers, agents and their constraints", () => {
      const db = new Database(":memory:");
      db.exec("pragma foreign_keys = on");
      try {
        migrate(db, MIGRATIONS.slice(0, 10));
        db.exec(`
          insert into providers (id, name, wire, base_url, key_name, created_at)
            values ('pr11', 'router', 'openrouter', 'http://models.test/v1', 'router', 17),
                   ('local11', 'local', 'openai-compatible', 'http://local.test/v1', null, 18);
          insert into agents
            (id, name, avatar, provider_id, model, model_name, context_length,
             prompt_price, completion_price, tools, reasoning, prompt, thinking,
             effort, created_at, mcp_mode)
            values ('a11', 'agent', 'dome', 'pr11', 'model', 'Model', 100000,
                    1.5, 2.5, 1, 1, 'Be brief', 'on', 'high', 19, 'catalog');
        `);
        const providers = db.query("select * from providers order by id").all();
        const agents = db.query("select * from agents").all();
        expect(() =>
          db
            .query("update providers set wire = 'gemini' where id = 'local11'")
            .run(),
        ).toThrow();
        expect(migrate(db, MIGRATIONS.slice(0, 15))).toEqual([
          "0011-gemini",
          "0012-fork",
          "0013-web-tools",
          "0014-visualize",
          "0015-knowledge",
        ]);
        expect(db.query("select * from providers order by id").all()).toEqual(
          providers,
        );
        expect(db.query("select * from agents").all()).toEqual(agents);
        db.exec(`
          insert into providers (id, name, wire, base_url, key_name, created_at)
            values ('gemini11', 'gemini', 'gemini', 'http://models.test/v1beta', 'gemini', 20);
          insert into agents
            (id, name, provider_id, model, model_name, created_at)
            values ('g11', 'gemini-agent', 'gemini11', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 21);
        `);
        expect(() =>
          db.query("update providers set wire = 'unknown'").run(),
        ).toThrow();
        expect(() =>
          db
            .query("update providers set name = 'router' where id = 'gemini11'")
            .run(),
        ).toThrow();
        expect(() =>
          db.query("delete from providers where id = 'pr11'").run(),
        ).toThrow();
        expect(() =>
          db.query("delete from providers where id = 'gemini11'").run(),
        ).toThrow();
        expect(db.query("pragma foreign_key_check").all()).toEqual([]);
        expect(db.query("pragma foreign_keys").get()).toEqual({
          foreign_keys: 1,
        });
        expect(migrate(db, MIGRATIONS.slice(0, 15))).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  describe("0016 openai-strict migration", () => {
    test("widens the wire check, keeps providers and agents, and marks their models described", () => {
      const db = new Database(":memory:");
      db.exec("pragma foreign_keys = on");
      try {
        migrate(db, MIGRATIONS.slice(0, 15));
        db.exec(`
          insert into providers (id, name, wire, base_url, key_name, created_at)
            values ('pr16', 'router', 'openrouter', 'http://models.test/v1', 'router', 17),
                   ('local16', 'local', 'openai-compatible', 'http://local.test/v1', null, 18);
          insert into agents
            (id, name, avatar, provider_id, model, model_name, context_length,
             prompt_price, completion_price, tools, reasoning, prompt, thinking,
             effort, created_at, mcp_mode)
            values ('a16', 'agent', 'dome', 'pr16', 'model', 'Model', 100000,
                    1.5, 2.5, 1, 1, 'Be brief', 'on', 'high', 19, 'catalog');
        `);
        const providers = db.query("select * from providers order by id").all();
        const agents = db.query("select * from agents").all() as Record<
          string,
          unknown
        >[];
        expect(() =>
          db
            .query(
              "update providers set wire = 'openai-strict' where id = 'local16'",
            )
            .run(),
        ).toThrow();
        expect(migrate(db)).toEqual([
          "0016-openai-strict",
          "0017-chat-uploads",
          "0018-web-access",
          "0019-open",
        ]);
        expect(MIGRATIONS[15]?.rebuild).toBe(true);
        expect(db.query("select * from providers order by id").all()).toEqual(
          providers,
        );
        expect(db.query("select * from agents").all()).toEqual(
          agents.map((agent) => ({ ...agent, model_described: 1 })),
        );
        db.exec(`
          insert into providers (id, name, wire, base_url, key_name, created_at)
            values ('nim16', 'nvidia', 'openai-strict', 'http://nim.test/v1', 'provider-nvidia', 20);
          insert into agents
            (id, name, provider_id, model, model_name, created_at, model_described)
            values ('n16', 'nim-agent', 'nim16', 'nvidia/nemotron', 'nvidia/nemotron', 21, 0);
        `);
        expect(() =>
          db.query("update providers set wire = 'unknown'").run(),
        ).toThrow();
        expect(() =>
          db.query("update agents set model_described = 2").run(),
        ).toThrow();
        expect(() =>
          db.query("delete from providers where id = 'nim16'").run(),
        ).toThrow();
        expect(db.query("pragma foreign_key_check").all()).toEqual([]);
        expect(db.query("pragma foreign_keys").get()).toEqual({
          foreign_keys: 1,
        });
        expect(migrate(db)).toEqual([]);
      } finally {
        db.close();
      }
    });
  });
});
