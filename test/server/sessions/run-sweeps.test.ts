// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server never runs ANALYZE, so the hourly sweeps over runs and the
// boot repair must plan well on the planner's defaults as well as with
// stats.

import { describe, expect, spyOn, test } from "bun:test";
import type { Db } from "../../../src/server/db/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { expiredAutomationRuns } from "../../../src/server/sessions/automation.ts";
import { SessionStore } from "../../../src/server/sessions/index.ts";
import { repairRows } from "../../../src/server/sessions/repair.ts";
import { sweepChats } from "../../../src/server/sessions/sweep.ts";
import { memoryDb } from "../../helpers/db.ts";

const HOUR = 3_600_000;
const NO_USAGE = { latest: () => null, latestFor: () => new Map() };
const NOW = 1_000 * 24 * HOUR;

// A year of hourly runs is what makes a walk of every run cost.
function history(): Db {
  const db = memoryDb();
  db.exec(`
    insert into users (id, username, full_name, email, role, password_hash, created_at)
      values ('u', 'user', 'User', 'user@example.com', 'member', 'x', 0);
    insert into projects (id, kind, name, owner_id, created_at)
      values ('t', 'team', 'team-one', 'u', 0);
    insert into providers (id, name, wire, base_url, created_at)
      values ('pr', 'prov', 'openai-compatible', 'http://x', 0);
    insert into agents (id, name, provider_id, model, model_name, created_at)
      values ('a', 'agent', 'pr', 'm', 'M', 0);
  `);
  const automation = db.query(
    `insert into automations (id, project_id, owner_id, agent_id, name,
       instructions, schedule, tz, retention_days, next_at, created_at,
       updated_at)
     values (?, 't', 'u', 'a', ?, 'go', '0 * * * *', 'UTC', 30, 1, 0, 0)`,
  );
  const session = db.query(
    `insert into sessions (id, project_id, owner_id, agent_id, origin,
       automation_id, title, status, created_at, last_activity_at)
     values (?, 't', 'u', 'a', ?, ?, 'run', 'done', ?, ?)`,
  );
  let n = 0;
  const id = () => (n++).toString(36).padStart(12, "0");
  for (let a = 0; a < 12; a++) {
    const automationId = id();
    automation.run(automationId, automationId);
    for (let r = 0; r < 720; r++) {
      const at = NOW - r * HOUR;
      session.run(id(), "automation", automationId, at, at);
    }
  }
  for (let r = 0; r < 100; r++) {
    session.run(id(), "automation", null, NOW - r * HOUR, NOW - r * HOUR);
  }
  for (let c = 0; c < 2000; c++) {
    session.run(id(), "chat", null, NOW - c * HOUR, NOW - c * HOUR);
  }
  db.exec(`
    insert into sessions
      (id, project_id, owner_id, agent_id, origin, title, status, created_at,
       last_activity_at)
      values ('channel-plan', 't', null, null, 'channel', 'team-one', 'done',
        0, 0);
    insert into sends
      (id, session_id, kind, user_id, agent_id, provider_id, provider_name,
       model, status, first_message_id, started_at, finished_at)
      values ('channel-send', 'channel-plan', 'chat', 'u', 'a', 'pr', 'prov',
        'm', 'done', 'channel-tool', -10000000000, -9999999999);
    insert into messages
      (id, session_id, seq, kind, send_id, round, content, status,
       tool_call_id, tool_name, created_at, finished_at)
      values ('channel-tool', 'channel-plan', 1, 'tool', 'channel-send', 1,
        'result', 'done', 'call', 'bash', -10000000000, -9999999999);
  `);
  return db;
}

// the statements a call prepares, each with its plan
function plans(db: Db, call: () => unknown): Map<string, string[]> {
  const query = spyOn(db, "query");
  let sqls: string[];
  try {
    call();
    sqls = query.mock.calls.map(([sql]) => sql);
  } finally {
    query.mockRestore();
  }
  return new Map(
    sqls.map((sql) => [
      sql,
      db
        .query<{ detail: string }, []>(`explain query plan ${sql}`)
        .all()
        .map((row) => row.detail),
    ]),
  );
}

describe("the sweeps over runs", () => {
  test("seek their indexes with and without planner stats", () => {
    const db = history();
    const scratch = { drop() {}, held: () => new Set<string>() };
    const store = new SessionStore(db, NO_USAGE, scratch);
    try {
      for (const stats of [false, true]) {
        if (stats) db.exec("analyze");
        const expired = [
          ...plans(db, () => expiredAutomationRuns(db, NO_USAGE, NOW)).values(),
        ];
        expect(expired).toHaveLength(1);
        expect(expired[0]).toContain(
          "SEARCH sessions USING INDEX sessions_automation (automation_id=? AND last_activity_at<?)",
        );
        expect(
          expired[0]!.some((line) => line.startsWith("SCAN sessions")),
        ).toBe(false);

        const sweep = plans(db, () =>
          sweepChats({ db, store, scratch, log: silent }, 0, DEFAULT_LIMITS),
        );
        const aged = [...sweep].find(([sql]) =>
          sql.includes("indexed by sends_channel_unswept"),
        );
        expect(aged).toBeDefined();
        expect(aged![1]).toContain(
          "SCAN sessions USING INDEX sessions_channel",
        );
        expect(aged![1]).toContain(
          "SEARCH sends USING INDEX sends_channel_unswept (session_id=? AND finished_at<?)",
        );
        expect(aged![1].some((line) => /SCAN sends/.test(line))).toBe(false);
        if (!stats) {
          const toolUpdate = [...sweep].find(([sql]) =>
            sql.startsWith("update messages set content"),
          );
          expect(toolUpdate![1]).toContain(
            "SEARCH messages USING INDEX messages_send (send_id=?)",
          );
          const childDelete = [...sweep].find(([sql]) =>
            sql.startsWith("delete from sessions where parent_message_id"),
          );
          expect(childDelete![1]).toContain(
            "SEARCH sessions USING COVERING INDEX sessions_parent_message (parent_message_id=?)",
          );
          expect(childDelete![1]).toContain(
            "SEARCH messages USING INDEX messages_send (send_id=?)",
          );
        }
        const orphans = [...sweep].filter(([sql]) =>
          sql.includes("automation_id is null"),
        );
        expect(orphans).toHaveLength(1);
        expect(orphans[0]![1]).toContain(
          "SEARCH sessions USING INDEX sessions_orphan_runs (last_activity_at<?)",
        );
        expect(
          orphans[0]![1].some((line) => line.startsWith("SCAN sessions")),
        ).toBe(false);

        // walking a feed index for running rows reads every entry
        const repair = [
          ...plans(db, () =>
            repairRows(db, NOW, "restart", {
              touch: () => {
                throw new Error("no running rows");
              },
              message: () => {
                throw new Error("no running rows");
              },
              lastSend: () => null,
              dropScratch: () => {},
            }),
          ),
        ].find(([sql]) => sql.includes("from sessions"));
        expect(
          repair![1].filter((line) => /^(SCAN|SEARCH) sessions\b/.test(line)),
        ).toEqual(["SCAN sessions"]);
      }
    } finally {
      db.close();
    }
  });
});
