// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { RawSession } from "../../../src/server/sessions/rows.ts";
import {
  ENVELOPE_ROW,
  envelopeRow,
  streamRows,
} from "../../../src/server/sessions/stream.ts";
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

// point lookups by key, and two newest-first walks of one session's
// index range that stop at their first match: no scan, no sort
const PLAN = [
  "SEARCH sessions USING INDEX sqlite_autoindex_sessions_1 (id=?)",
  "SEARCH agents USING INDEX sqlite_autoindex_agents_1 (id=?)",
  "SEARCH automations USING INDEX sqlite_autoindex_automations_1 (id=?) LEFT-JOIN",
  "SEARCH runner USING INDEX sqlite_autoindex_users_1 (id=?) LEFT-JOIN",
  "SEARCH line USING INDEX sqlite_autoindex_messages_2 (session_id=? AND seq=?) LEFT-JOIN",
  "CORRELATED SCALAR SUBQUERY 2",
  "SEARCH newest USING INDEX sqlite_autoindex_messages_2 (session_id=?)",
  "SEARCH author USING INDEX sqlite_autoindex_users_1 (id=?) LEFT-JOIN",
  "SEARCH speaker USING INDEX sqlite_autoindex_agents_1 (id=?) LEFT-JOIN",
  "SEARCH last USING INDEX sqlite_autoindex_sends_1 (id=?) LEFT-JOIN",
  "CORRELATED SCALAR SUBQUERY 3",
  "SEARCH newest USING INDEX sends_session (session_id=?)",
  "CORRELATED SCALAR SUBQUERY 1",
  "SEARCH usage USING INDEX usage_send_round (send_id=?)",
];

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
    const listed = streamRows(db, raws, new Map());
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

  test("is one statement of index lookups", () => {
    const { db } = seeded();
    // stats over tables of a row or two would pick a scan
    for (let i = 0; i < 100; i++) {
      db.query(
        `insert into users (id, username, full_name, email, role,
           password_hash, created_at)
         values (?, ?, 'U', ?, 'member', 'x', 0)`,
      ).run(`user${i}`, `user${i}`, `u${i}@example.com`);
      db.query(
        `insert into agents (id, name, provider_id, model, model_name,
           created_at)
         values (?, ?, 'pr', 'm', 'M', 0)`,
      ).run(`agent${i}`, `agent${i}`);
      db.query(
        `insert into automations (id, project_id, owner_id, agent_id, name,
           instructions, schedule, tz, retention_days, next_at, created_at,
           updated_at)
         values (?, 'p', 'u', 'a', ?, 'go', '0 * * * *', 'UTC', 30, 1, 0, 0)`,
      ).run(`auto${i}`, `auto${i}`);
    }
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec("analyze");
      const plan = db
        .query<{ detail: string }, [string]>(
          `explain query plan ${ENVELOPE_ROW}`,
        )
        .all("x")
        .map((row) => row.detail);
      expect(plan).toEqual(PLAN);
    }
  });
});
