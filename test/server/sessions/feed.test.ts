// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The original statement stays unchanged as the feed's oracle.

import { describe, expect, spyOn, test } from "bun:test";
import type { Db } from "../../../src/server/db/index.ts";
import type { FeedCursor } from "../../../src/server/sessions/cursor.ts";
import {
  feedAfter,
  feedCursor,
  parseFeedCursor,
} from "../../../src/server/sessions/cursor.ts";
import { feedRead, listSessions } from "../../../src/server/sessions/list.ts";
import type { RawSession } from "../../../src/server/sessions/rows.ts";
import { streamRows } from "../../../src/server/sessions/stream.ts";
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

const TITLES = [
  "alpha",
  "beta",
  "al_pha",
  "100% done",
  "Gamma",
  "chat",
  "a_\\50%",
  "path\\file",
];
const STATUSES = ["done", "failed", "stopped", "running"] as const;

// Few timestamps make ties common, including a running run that is not newest.
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
       archived_at, archived_reason, revision, run_source, disabled_capabilities)
     values (?, ?, 'u', 'a', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
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
      n,
      origin === "automation" ? rnd.pick(["manual", "schedule"]) : null,
      n % 2 === 0 ? '["web"]' : "[]",
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
        add(
          projectId,
          "automation",
          automationId,
          "running",
          rnd.pick([newest + 1, newest, 0]),
        );
      }
    }
  }
  return { db, projectIds, rnd };
}

const ORIGINS: Origin[] = [null, "chat", "automation"];
const QUERIES = ["", "al", "a_", "%", "\\", "a_\\", "zz"];

function compare(
  db: Db,
  projectIds: string[],
  q: string,
  origin: Origin,
  before: FeedCursor | null,
  limit: number,
): FeedCursor | null {
  const ids = oracle(db, projectIds, q, origin, before, limit);
  const want = ids.map(
    (id) =>
      db
        .query<RawSession, [string]>("select * from sessions where id = ?")
        .get(id)!,
  );
  const got = feedRead(db, projectIds, q, origin, before, limit);
  expect({ projectIds, q, origin, before, limit, got }).toEqual({
    projectIds,
    q,
    origin,
    before,
    limit,
    got: want,
  });
  const response = listSessions(
    db,
    { latest: () => null, latestFor: () => new Map() },
    projectIds,
    q,
    origin,
    before,
    limit,
  );
  const next = want.length > limit ? feedCursor(want[limit - 1]!) : null;
  const counts = new Map(
    db
      .query<{ id: string; n: number }, []>(
        `select automation_id as id, count(*) as n from sessions
         where automation_id is not null group by automation_id`,
      )
      .all()
      .map((row) => [row.id, row.n]),
  );
  expect(response).toEqual({
    rows: streamRows(
      db,
      want.slice(0, limit),
      new Map(),
      origin === null ? counts : undefined,
    ),
    next,
  });
  return response.next === null ? null : parseFeedCursor(response.next);
}

describe("the feed's ordered project ranges", () => {
  test("literal escapes, deleted cursors and index-changing writes retain the oracle", () => {
    const { db, projectIds } = fixture(13, 6);
    try {
      db.exec(`
        insert into sessions
          (id, project_id, owner_id, agent_id, origin, title, status,
           created_at, last_activity_at)
        values
          ('zzzzzzzzzzz1', 'project0', 'u', 'a', 'chat', 'a_\\50%', 'running', 0, 12),
          ('zzzzzzzzzzz2', 'project0', 'u', 'a', 'chat', 'ax50x', 'done', 0, 12);
      `);
      for (const q of ["a_", "\\", "%", "a_\\50%"]) {
        expect(oracle(db, projectIds, q, "chat", null, 100)).toContain(
          "zzzzzzzzzzz1",
        );
        expect(oracle(db, projectIds, q, "chat", null, 100)).not.toContain(
          "zzzzzzzzzzz2",
        );
        for (const origin of ORIGINS)
          compare(db, projectIds, q, origin, null, 3);
      }
      const deleted: FeedCursor = { running: 1, at: 12, id: "zzzzzzzzzzz1" };
      db.exec("delete from sessions where id = 'zzzzzzzzzzz1'");
      db.exec(`
        update sessions set status = 'running', last_activity_at = 13,
          revision = revision + 1 where id = 'zzzzzzzzzzz2';
        delete from automations where project_id = 'project0';
      `);
      for (const origin of ORIGINS) {
        for (const q of QUERIES) {
          compare(db, projectIds, q, origin, deleted, 3);
          compare(db, projectIds, q, origin, { ...deleted, running: 0 }, 3);
          compare(db, projectIds, q, origin, null, 50);
        }
      }
    } finally {
      db.close();
    }
  });

  test("answers the one statement's rows and order", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { db, projectIds, rnd } = fixture(seed, 6);
      const subsets = [
        projectIds,
        projectIds.filter(() => rnd.int(2) === 0),
        [projectIds[0]!],
        [projectIds[0]!, projectIds[0]!],
        [],
        ["nothing"],
      ];
      for (const ids of subsets) {
        for (const origin of ORIGINS) {
          for (const q of QUERIES) {
            for (const limit of [1, 3, 50]) {
              let before: FeedCursor | null = null;
              for (let page = 0; page < 60; page++) {
                before = compare(db, ids, q, origin, before, limit);
                if (before === null) break;
                expect(page).toBeLessThan(59);
              }
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

  test("pages across former batch boundaries without changing SQL shape", () => {
    const { db, projectIds } = fixture(9, 501);
    try {
      for (const size of [
        1, 4, 7, 8, 9, 15, 16, 17, 30, 100, 199, 200, 201, 499, 500, 501,
      ]) {
        const ids = projectIds.slice(0, size).reverse();
        for (const origin of ORIGINS) {
          for (const q of QUERIES) {
            let before: FeedCursor | null = null;
            for (let page = 0; page < 250; page++) {
              before = compare(db, ids, q, origin, before, 50);
              if (before === null) break;
              expect(page).toBeLessThan(249);
            }
            for (const running of [0, 1] as const) {
              compare(
                db,
                ids,
                q,
                origin,
                { running, at: 5, id: "zzzzzzzzzzzz" },
                7,
              );
            }
          }
        }
      }
    } finally {
      db.close();
    }
  }, 30_000);

  test("every statement seeks its indexes, with and without planner stats", () => {
    const { db, projectIds } = fixture(11, 501);
    const shapes = new Set<string>();
    try {
      for (const stats of [false, true]) {
        if (stats) db.exec("analyze");
        for (const size of [
          1, 4, 8, 9, 15, 16, 17, 30, 100, 199, 200, 201, 499, 500, 501,
        ]) {
          for (const origin of ORIGINS) {
            for (const q of ["", "al", "\\", "zz"]) {
              for (const before of [
                null,
                { running: 0, at: 5, id: "000000000009" },
                { running: 1, at: 5, id: "000000000009" },
                { running: 1, at: 0, id: "zzzzzzzzzzzz" },
              ] satisfies (FeedCursor | null)[]) {
                const statements = capture(
                  db,
                  projectIds.slice(0, size),
                  q,
                  origin,
                  before,
                );
                expect(statements.length).toBeGreaterThanOrEqual(
                  origin === null ? 2 : 1,
                );
                expect(statements.length).toBeLessThanOrEqual(
                  origin === null ? 3 : 2,
                );
                for (const { sql, bound } of statements) {
                  shapes.add(sql);
                  expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(
                    9,
                  );
                  expect(sql).toContain("in (select value from json_each(?))");
                  expect(sql).not.toContain("union all");
                  assertPlan(db, bound);
                  if (!sql.includes("newest")) assertEarlyExit(db, bound);
                  if (sql.includes("newest")) {
                    expect(() =>
                      assertPlan(
                        db,
                        bound.replace(
                          "newest indexed by sessions_automation",
                          "newest not indexed",
                        ),
                      ),
                    ).toThrow("SCAN newest");
                  }
                }
              }
            }
          }
        }
      }
      expect(shapes.size).toBe(14);
    } finally {
      db.close();
    }
  }, 30_000);
});

function capture(
  db: Db,
  ids: string[],
  q: string,
  origin: Origin,
  before: FeedCursor | null,
) {
  const query = spyOn(db, "query");
  let sqls: string[];
  try {
    feedRead(db, ids, q, origin, before, 50);
    sqls = query.mock.calls.map(([sql]) => sql);
  } finally {
    query.mockRestore();
  }
  return sqls.map((sql) => ({ sql, bound: db.query(sql).toString() }));
}

function assertPlan(db: Db, sql: string) {
  const plan = db
    .query<{ detail: string }, []>(`explain query plan ${sql}`)
    .all()
    .map((row) => row.detail);
  const aliases = [
    ...sql.matchAll(
      /\b(?:from|join)\s+sessions(?:\s+(?!indexed\b|not\b|where\b|on\b)(\w+))?/gi,
    ),
  ].map((match) => match[1] ?? "sessions");
  for (const alias of aliases) {
    const scan = plan.find((line) =>
      new RegExp(`^SCAN (?:TABLE )?${alias}\\b`).test(line),
    );
    if (scan) throw new Error(scan);
  }
  const sessions = plan.filter((line) =>
    /^SEARCH (sessions|newest)\b/.test(line),
  );
  expect(sessions).toHaveLength(aliases.length);
  if (sql.includes("newest")) {
    expect(plan).toContain(
      "SEARCH automations USING INDEX sqlite_autoindex_automations_2 (project_id=?)",
    );
    expect(sessions).toContain(
      "SEARCH sessions USING INDEX sqlite_autoindex_sessions_1 (id=?)",
    );
    expect(sessions).toContain(
      "SEARCH newest USING INDEX sessions_automation (automation_id=?)",
    );
  } else {
    const unowned = sql.includes("sessions_feed_unowned");
    const index = unowned ? "sessions_feed_unowned" : "sessions_feed";
    const origin = unowned ? "" : " AND origin=?";
    const rank = /and \(status = 'running'\) = [01]/.test(sql)
      ? " AND <expr>=?"
      : "";
    const range = sql.includes("last_activity_at <=")
      ? " AND last_activity_at<?"
      : "";
    expect(sessions).toEqual([
      `SEARCH sessions USING INDEX ${index} (project_id=?${origin}${rank}${range})`,
    ]);
  }
}

function assertEarlyExit(db: Db, sql: string) {
  const ops = db
    .query<{ addr: number; opcode: string; p1: number; p2: number }, []>(
      `explain ${sql}`,
    )
    .all();
  const cut = ops.find((op) => op.opcode === "IdxLE");
  expect(cut).toBeDefined();
  const nextProject = ops.find((op) => op.addr === cut?.p2);
  const nextSession = ops.find((op) => op.addr === (cut?.p2 ?? 0) - 1);
  expect(nextProject?.opcode).toBe("Next");
  expect(nextSession?.opcode).toBe("Next");
  expect(nextProject?.p1).not.toBe(nextSession?.p1);
}
