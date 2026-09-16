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
        name: "datetime",
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
    expect(migrate(db)).toEqual(["0009-mcp", "0010-memory", "0011-gemini"]);
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
    expect(migrate(db)).toEqual([
      "0008-search-tavily",
      "0009-mcp",
      "0010-memory",
      "0011-gemini",
    ]);
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
        expect(migrate(db)).toEqual(["0011-gemini"]);
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
        expect(migrate(db)).toEqual([]);
      } finally {
        db.close();
      }
    });
  });
});
