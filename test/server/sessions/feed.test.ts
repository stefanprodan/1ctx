// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The feed read in arms answers what the one statement over every
// project answered: that statement is kept here as the oracle.

import { describe, expect, spyOn, test } from "bun:test";
import type { Db } from "../../../src/server/db/index.ts";
import type { FeedCursor } from "../../../src/server/sessions/cursor.ts";
import { feedAfter } from "../../../src/server/sessions/cursor.ts";
import { feedRead } from "../../../src/server/sessions/list.ts";
import { memoryDb } from "../../helpers/db.ts";

type Origin = "chat" | "automation" | null;

const ORDER = "order by status = 'running' desc, last_activity_at desc, id";

function oracle(
  db: Db,
  projectIds: string[],
  q: string,
  origin: Origin,
  before: FeedCursor | null,
  limit: number,
): string[] {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => "?").join(", ");
  const needle = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const after = feedAfter(before);
  const rows =
    origin === null
      ? db
          .query<{ id: string }, (string | number)[]>(
            `select * from (
              select * from sessions
              where project_id in (${marks}) and automation_id is null
                and (? = '' or title like ? escape '\\')
              union all
              select sessions.* from automations
              join sessions on sessions.id = (
                select newest.id from sessions newest
                where newest.automation_id = automations.id
                  and (? = '' or newest.title like ? escape '\\')
                order by newest.last_activity_at desc, newest.id limit 1)
              where automations.project_id in (${marks})
            )
            where true ${after.sql}
            ${ORDER} limit ?`,
          )
          .all(
            ...projectIds,
            q,
            needle,
            q,
            needle,
            ...projectIds,
            ...after.args,
            limit + 1,
          )
      : db
          .query<{ id: string }, (string | number)[]>(
            `select * from sessions
             where project_id in (${marks})
               and (? = '' or title like ? escape '\\')
               and origin = ?
               ${after.sql}
             ${ORDER} limit ?`,
          )
          .all(...projectIds, q, needle, origin, ...after.args, limit + 1);
  return rows.map((row) => row.id);
}

function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!,
  };
}

const TITLES = ["alpha", "beta", "al_pha", "100% done", "Gamma", "chat"];
const STATUSES = ["done", "failed", "stopped", "running"] as const;

// projects with chats, archived chats, runs of live automations (at most
// one running, the newest) and runs whose automation is gone, on few
// timestamps so ties are common
function fixture(seed: number, projects: number) {
  const db = memoryDb();
  const rnd = random(seed);
  db.query(
    "insert into users (id, username, full_name, email, role, password_hash, created_at) values ('u', 'user', 'User', 'user@example.com', 'member', 'x', 0)",
  ).run();
  db.query(
    "insert into providers (id, name, wire, base_url, created_at) values ('pr', 'prov', 'openai-compatible', 'http://x', 0)",
  ).run();
  db.query(
    "insert into agents (id, name, provider_id, model, model_name, created_at) values ('a', 'agent', 'pr', 'm', 'M', 0)",
  ).run();
  let n = 0;
  const id = () => (n++).toString(36).padStart(12, "0");
  const session = db.query(
    `insert into sessions (id, project_id, owner_id, agent_id, origin,
       automation_id, title, status, created_at, last_activity_at,
       archived_at, archived_reason)
     values (?, ?, 'u', 'a', ?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  const add = (
    projectId: string,
    origin: "chat" | "automation",
    automationId: string | null,
    status: string,
    at: number,
  ) => {
    const archived = origin === "chat" && rnd.int(5) === 0;
    session.run(
      id(),
      projectId,
      origin,
      automationId,
      rnd.pick(TITLES),
      status,
      at,
      archived ? at : null,
      archived ? "manual" : null,
    );
  };
  const projectIds: string[] = [];
  for (let p = 0; p < projects; p++) {
    const projectId = `project${p}`;
    projectIds.push(projectId);
    db.query(
      "insert into projects (id, kind, name, owner_id, created_at) values (?, 'team', ?, 'u', 0)",
    ).run(projectId, projectId);
    for (let c = rnd.int(9); c > 0; c--) {
      add(projectId, "chat", null, rnd.pick(STATUSES), rnd.int(12));
    }
    for (let g = rnd.int(3); g > 0; g--) {
      add(projectId, "automation", null, rnd.pick(STATUSES), rnd.int(12));
    }
    for (let a = rnd.int(4); a > 0; a--) {
      const automationId = id();
      db.query(
        `insert into automations (id, project_id, owner_id, agent_id, name,
           instructions, schedule, tz, retention_days, next_at, created_at,
           updated_at)
         values (?, ?, 'u', 'a', ?, 'go', '0 * * * *', 'UTC', 30, 1, 0, 0)`,
      ).run(automationId, projectId, automationId);
      let newest = 0;
      for (let r = rnd.int(7); r > 0; r--) {
        const at = rnd.int(12);
        newest = Math.max(newest, at);
        add(
          projectId,
          "automation",
          automationId,
          rnd.pick(STATUSES.slice(0, 3)),
          at,
        );
      }
      if (rnd.int(3) === 0) {
        add(projectId, "automation", automationId, "running", newest + 1);
      }
    }
  }
  return { db, projectIds, rnd };
}

const ORIGINS: Origin[] = [null, "chat", "automation"];
const QUERIES = ["", "al", "a_", "%", "zz"];

function compare(
  db: Db,
  projectIds: string[],
  q: string,
  origin: Origin,
  before: FeedCursor | null,
  limit: number,
): string[] {
  const want = oracle(db, projectIds, q, origin, before, limit);
  const got = feedRead(db, projectIds, q, origin, before, limit).map(
    (row) => row.id,
  );
  expect({ projectIds, q, origin, before, limit, got }).toEqual({
    projectIds,
    q,
    origin,
    before,
    limit,
    got: want,
  });
  return want;
}

function cursorOf(db: Db, id: string): FeedCursor {
  const row = db
    .query<{ status: string; last_activity_at: number }, [string]>(
      "select status, last_activity_at from sessions where id = ?",
    )
    .get(id)!;
  return {
    running: row.status === "running" ? 1 : 0,
    at: row.last_activity_at,
    id,
  };
}

describe("the feed read in arms", () => {
  test("answers the one statement's rows and order", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { db, projectIds, rnd } = fixture(seed, 6);
      const subsets = [
        projectIds,
        projectIds.filter(() => rnd.int(2) === 0),
        [projectIds[0]!],
        ["nothing"],
      ];
      for (const ids of subsets) {
        for (const origin of ORIGINS) {
          for (const q of QUERIES) {
            for (const limit of [1, 3, 50]) {
              // every page, following the cursor each answer gives
              let before: FeedCursor | null = null;
              for (let page = 0; page < 60; page++) {
                const read = compare(db, ids, q, origin, before, limit);
                if (read.length <= limit) break;
                before = cursorOf(db, read[limit - 1]!);
              }
              // cursors of both ranks at any place, a deleted row's too
              for (let k = 0; k < 6; k++) {
                const cursor: FeedCursor = {
                  running: rnd.int(2) === 0 ? 0 : 1,
                  at: rnd.int(14) - 1,
                  id: rnd.int(200).toString(36).padStart(12, "0"),
                };
                compare(db, ids, q, origin, cursor, limit);
              }
            }
          }
        }
      }
      db.close();
    }
  });

  test("merges project lists that cross a batch", () => {
    const { db, projectIds, rnd } = fixture(9, 260);
    for (const origin of ORIGINS) {
      for (const q of ["", "al"]) {
        let before: FeedCursor | null = null;
        for (let page = 0; page < 200; page++) {
          const read = compare(db, projectIds, q, origin, before, 50);
          if (read.length <= 50) break;
          before = cursorOf(db, read[49]!);
        }
        compare(
          db,
          projectIds,
          q,
          origin,
          {
            running: 1,
            at: rnd.int(12),
            id: "000000000000",
          },
          7,
        );
      }
    }
    db.close();
  });

  test("each arm seeks its index, with and without planner stats", () => {
    const { db, projectIds } = fixture(11, 4);
    const plans = () => {
      const out: { sql: string; ranged: boolean }[] = [];
      for (const origin of ORIGINS) {
        for (const before of [
          null,
          { running: 0, at: 5, id: "000000000009" },
          { running: 1, at: 5, id: "000000000009" },
        ] as FeedCursor[]) {
          const query = spyOn(db, "query");
          try {
            feedRead(db, projectIds, "al", origin, before, 50);
            for (const [sql] of query.mock.calls) {
              if (sql.includes("indexed by")) {
                out.push({ sql, ranged: before?.running === 0 });
              }
            }
          } finally {
            query.mockRestore();
          }
        }
      }
      return out;
    };
    const explain = (sql: string) => {
      const marks = (sql.match(/\?/g) ?? []).length;
      return db
        .query<{ detail: string }, (string | number)[]>(
          `explain query plan ${sql}`,
        )
        .all(...Array.from({ length: marks }, () => 1))
        .map((row) => row.detail);
    };
    for (const stats of [false, true]) {
      if (stats) db.exec("analyze");
      const statements = plans();
      expect(statements.length).toBe(9);
      for (const { sql, ranged } of statements) {
        const plan = explain(sql);
        const scans = plan.filter((line) => /^SCAN sessions\b/.test(line));
        expect({ sql, scans }).toEqual({ sql, scans: [] });
        // a rank-0 cursor is a range the index seeks, not a filter
        const feed = ranged
          ? "(project_id=? AND origin=? AND last_activity_at<?)"
          : "(project_id=? AND origin=?)";
        for (const line of plan.filter((l) => l.includes("sessions_feed"))) {
          expect(line).toBe(
            `SEARCH sessions USING INDEX sessions_feed ${feed}`,
          );
        }
        for (const line of plan.filter((l) => l.includes("sessions_running"))) {
          expect(line).toMatch(
            /USING INDEX sessions_running \(project_id=\?\)/,
          );
        }
      }
    }
    db.close();
  });
});
