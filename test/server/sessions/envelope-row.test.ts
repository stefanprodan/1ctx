// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Db } from "../../../src/server/db/index.ts";
import {
  ENVELOPE_ROW,
  envelopeRow,
  feedRows,
  lastLinesSql,
} from "../../../src/server/sessions/feed.ts";
import type { RawSession } from "../../../src/server/sessions/rows.ts";
import { memoryDb } from "../../helpers/db.ts";

function seeded() {
  const db = memoryDb();
  db.exec(`
    insert into users (id, username, full_name, email, role, password_hash, created_at)
      values ('u', 'casey', 'Casey', 'c@example.com', 'member', 'x', 0),
             ('v', 'drew', 'Drew', 'd@example.com', 'member', 'x', 0);
    insert into projects (id, kind, name, owner_id, created_at)
      values ('p', 'team', 'team', 'u', 0);
    insert into providers (id, name, wire, base_url, created_at)
      values ('pr', 'prov', 'openai-compatible', 'http://x', 0);
    insert into agents (id, name, provider_id, model, model_name, created_at, deleted_at)
      values ('a', 'coder', 'pr', 'm', 'M', 0, null),
             ('gone', 'old', null, 'm', 'M', 0, 5);
    insert into automations (id, project_id, owner_id, agent_id, name,
        instructions, schedule, tz, retention_days, next_at, created_at, updated_at)
      values ('au', 'p', 'u', 'a', 'digest', 'go', '0 * * * *', 'UTC', 30, 1, 0, 0);
  `);
  const session = (
    id: string,
    fields: Partial<{
      agent: string;
      owner: string;
      origin: string;
      automation: string | null;
      source: string | null;
      status: string;
    }> = {},
  ) =>
    db
      .query(
        `insert into sessions (id, project_id, owner_id, agent_id, origin,
           automation_id, run_source, title, status, created_at,
           last_activity_at, revision, disabled_capabilities)
         values (?, 'p', ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, '[]')`,
      )
      .run(
        id,
        fields.owner ?? "u",
        fields.agent ?? "a",
        fields.origin ?? "chat",
        fields.automation ?? null,
        fields.source ?? null,
        id,
        fields.status ?? "done",
      );
  const sendRow = (id: string, sessionId: string, startedAt: number) => {
    db.query(
      `insert into sends (id, session_id, kind, user_id, agent_id,
         provider_id, provider_name, model, status, first_message_id,
         started_at)
       values (?, ?, 'chat', 'u', 'a', 'pr', 'prov', 'm', 'done', 'x', ?)`,
    ).run(id, sessionId, startedAt);
    db.query(
      `insert into usage (id, send_id, session_id, project_id, user_id,
         agent_id, provider_id, model, round, seq, prompt_tokens,
         completion_tokens, created_at)
       values (?, ?, ?, 'p', 'u', 'a', 'pr', 'm', 1, 1, 10, 5, 0)`,
    ).run(`usage-${id}`, id, sessionId);
  };
  let n = 0;
  const message = (
    sessionId: string,
    sendId: string,
    seq: number,
    kind: "user" | "reply" | "tool" | "summary",
    content: string,
    fields: Partial<{ slot: string; status: string; user: string }> = {},
  ) =>
    db
      .query(
        `insert into messages (id, session_id, seq, kind, send_id, round,
           slot, user_id, agent_id, content, status, tool_call_id,
           tool_name, created_at)
         values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        `m${n++}`,
        sessionId,
        seq,
        kind,
        sendId,
        kind === "reply" ? (fields.slot ?? "answer") : null,
        kind === "user" ? (fields.user ?? "u") : null,
        kind === "user" ? null : "a",
        content,
        fields.status ?? "done",
        kind === "tool" ? `c${n}` : null,
        kind === "tool" ? "bash" : null,
      );
  return { db, session, sendRow, message };
}

type Op = { addr: number; opcode: string; p1: number; p2: number };

// Whether every read of a messages row in the statement tests kind
// before it touches status or content: status sits past content in the
// row, so reading either first follows a large tool row's overflow
// pages. The order is SQLite's code generation, pinned from bytecode.
function kindFirst(db: Db, sql: string, args: string[]): boolean {
  const root = db
    .query<{ rootpage: number }, []>(
      "select rootpage from sqlite_master where name = 'messages'",
    )
    .get()!.rootpage;
  const columns = db
    .query<{ cid: number; name: string }, []>("pragma table_info(messages)")
    .all();
  const cid = (name: string) => columns.find((c) => c.name === name)!.cid;
  const ops = db.query<Op, string[]>(`explain ${sql}`).all(...args);
  const cursors = new Set(
    ops
      .filter((op) => op.opcode === "OpenRead" && op.p2 === root)
      .map((op) => op.p1),
  );
  let tested = 0;
  for (const cursor of cursors) {
    const reads = ops.filter(
      (op) => op.opcode === "Column" && op.p1 === cursor,
    );
    const first = (name: string) =>
      reads.find((op) => op.p2 === cid(name))?.addr ?? Infinity;
    // a cursor that never tests kind reads the chosen row itself
    if (first("kind") === Infinity) continue;
    tested++;
    if (first("kind") > Math.min(first("status"), first("content"))) {
      return false;
    }
  }
  return tested > 0;
}

describe("the envelope row", () => {
  test("reads what the list reads, for every shape of session", () => {
    const { db, session, sendRow, message } = seeded();
    // a finished turn, then tool rows and a work reply past the answer
    session("chat");
    sendRow("s1", "chat", 1);
    message("chat", "s1", 1, "user", "hello");
    message("chat", "s1", 2, "reply", "## The **answer**", { slot: "answer" });
    message("chat", "s1", 3, "tool", "x".repeat(20_000));
    message("chat", "s1", 4, "reply", "thinking", { slot: "work" });
    // a turn in flight: its streaming reply is never the line
    session("live", { status: "running" });
    sendRow("s2", "live", 1);
    sendRow("s3", "live", 2);
    message("live", "s2", 1, "user", "first", { user: "v" });
    message("live", "s3", 2, "user", "second", { user: "v" });
    message("live", "s3", 3, "reply", "partial", { status: "streaming" });
    // two sends started at once: the later row is the last send
    session("tied");
    sendRow("t1", "tied", 7);
    sendRow("t2", "tied", 7);
    message("tied", "t2", 1, "summary", "a summary is never the line");
    // the newest line is markers alone: no line, never an older one
    session("markers");
    sendRow("k1", "markers", 1);
    message("markers", "k1", 1, "user", "words");
    message("markers", "k1", 2, "reply", "**", { slot: "answer" });
    // an empty answer is passed for the one before it
    session("empty");
    sendRow("e1", "empty", 1);
    message("empty", "e1", 1, "user", "the line");
    message("empty", "e1", 2, "reply", "", { slot: "answer" });
    // no send at all
    session("bare");
    // runs: pressed by a user, scheduled, and one whose automation is gone
    session("manual", {
      origin: "automation",
      automation: "au",
      source: "manual",
      owner: "v",
    });
    session("scheduled", {
      origin: "automation",
      automation: "au",
      source: "schedule",
    });
    session("orphan", { origin: "automation", source: "manual" });
    // a retired agent keeps its name
    session("retired", { agent: "gone" });

    const raws = db
      .query<RawSession, []>("select * from sessions order by id")
      .all();
    const listed = feedRows(db, raws, new Map());
    expect(raws).toHaveLength(10);
    for (const row of listed) {
      const { session: _session, runs: _runs, ...shared } = row;
      expect(envelopeRow(db, row.session.id)).toEqual(shared);
    }
    const byId = new Map(listed.map((row) => [row.session.id, row]));
    // the fixture reaches every branch it names
    expect(byId.get("chat")?.last?.text).toBe("The answer");
    expect(byId.get("live")?.last).toEqual({
      seq: 2,
      author: "drew",
      text: "second",
    });
    expect(byId.get("live")?.send?.id).toBe("s3");
    expect(byId.get("tied")?.send?.id).toBe("t2");
    expect(byId.get("tied")?.send?.tokens).toBe(15);
    expect(byId.get("markers")?.last).toBeNull();
    expect(byId.get("empty")?.last?.text).toBe("the line");
    expect(byId.get("bare")?.send).toBeNull();
    expect(byId.get("manual")?.runBy).toEqual({ id: "v", username: "drew" });
    expect(byId.get("manual")?.automation).toEqual({
      id: "au",
      name: "digest",
    });
    expect(byId.get("scheduled")?.runBy).toBeNull();
    expect(byId.get("orphan")?.automation).toBeNull();
    expect(byId.get("retired")?.agentRetired).toBe(true);
  });

  test("is null for a session that is gone", () => {
    const { db } = seeded();
    expect(envelopeRow(db, "nothing")).toBeNull();
  });

  test("seeks one session and walks only its own rows", () => {
    const { db } = seeded();
    // with stats over a table of an agent or two SQLite scans it, which
    // costs nothing; what matters is that no history table is walked
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec("analyze");
      const plan = db
        .query<{ detail: string }, [string]>(
          `explain query plan ${ENVELOPE_ROW}`,
        )
        .all("x")
        .map((row) => row.detail);
      expect(plan[0]).toStartWith("SEARCH sessions USING INDEX");
      expect(plan[0]).toEndWith("(id=?)");
      expect(
        plan.filter((line) =>
          /^SCAN (sessions|line|newest|last|usage)\b/.test(line),
        ),
      ).toEqual([]);
      expect(plan.filter((line) => line.includes("TEMP B-TREE"))).toEqual([]);
      expect(plan).toContain(
        "SEARCH newest USING INDEX sqlite_autoindex_messages_2 (session_id=?)",
      );
      expect(plan).toContain(
        "SEARCH newest USING INDEX sends_session (session_id=?)",
      );
    }
  });
});

describe("a last line read", () => {
  test("tests kind before it reads status or content", () => {
    const { db, session, sendRow, message } = seeded();
    session("chat");
    sendRow("s1", "chat", 1);
    message("chat", "s1", 1, "user", "hello");
    for (let seq = 2; seq < 12; seq++) {
      message("chat", "s1", seq, "tool", "x".repeat(50_000));
    }
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec("analyze");
      expect(kindFirst(db, ENVELOPE_ROW, ["chat"])).toBe(true);
      expect(kindFirst(db, lastLinesSql(1), ["chat"])).toBe(true);
      expect(kindFirst(db, lastLinesSql(3), ["chat", "a", "b"])).toBe(true);
    }
  });

  test("the check fails a statement that reads status first", () => {
    const { db } = seeded();
    const statusFirst = `select seq from messages
      where session_id = ? and status != 'streaming' and content != ''
        and (kind = 'user' or (kind = 'reply' and slot = 'answer'))
      order by seq desc limit 1`;
    expect(kindFirst(db, statusFirst, ["chat"])).toBe(false);
  });
});
