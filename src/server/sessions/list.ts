// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The feed reads each project in arms, each through its own index in its
// own order and cut at a page, and merges them in the feed's order: one
// statement over every project had to sort all its rows, since neither
// the running rank nor a project list reads an index in order. A row
// filter (the search, the cursor) inside an arm is exact before its cut.

import type { SessionsResponse } from "../../shared/api/sessions.ts";
import type { Db } from "../db/index.ts";
import { type FeedCursor, feedAfter, feedCursor } from "./cursor.ts";
import type { RawSession, UsagePort } from "./rows.ts";
import { STREAM_LIMIT } from "./rows.ts";
import { streamRows } from "./stream.ts";

export type ListArgs = [
  projectIds: string[],
  q: string,
  origin?: "chat" | "automation" | null,
  before?: FeedCursor | null,
  limit?: number,
];

type Part = { sql: string; args: (string | number)[] };

const ORDER = "order by status = 'running' desc, last_activity_at desc, id";
const SEARCH = "and (? = '' or title like ? escape '\\')";
// terms per compound select, under SQLite's 500
const BATCH = 200;

// where an arm of one rank starts after the cursor, as a range its index
// seeks; null when the whole arm is above the cursor
function place(before: FeedCursor | null, running: 0 | 1): Part | null {
  if (before === null || before.running > running) return { sql: "", args: [] };
  if (before.running < running) return null;
  return {
    sql: "and last_activity_at <= ? and (last_activity_at < ? or id > ?)",
    args: [before.at, before.at, before.id],
  };
}

function arm(
  index: string,
  where: string,
  args: (string | number)[],
  search: [string, string],
  at: Part | null,
  limit: number,
): Part[] {
  if (at === null) return [];
  return [
    {
      sql: `select * from (select * from sessions indexed by ${index}
        where ${where} ${SEARCH} ${at.sql}
        order by last_activity_at desc, id limit ?)`,
      args: [...args, ...search, ...at.args, limit + 1],
    },
  ];
}

// each automation's newest run holding the query, found through its
// index; the cursor applies after the choice, so an automation already
// passed never comes back. An automation never runs twice at once, so
// its running run is its newest by activity
function newestRuns(
  projectIds: string[],
  search: [string, string],
  before: FeedCursor | null,
  limit: number,
): Part {
  const marks = projectIds.map(() => "?").join(", ");
  const after = feedAfter(before);
  return {
    sql: `select * from (select * from (
        select sessions.* from automations
        join sessions on sessions.id = (
          select newest.id from sessions newest
          where newest.automation_id = automations.id
            and (? = '' or newest.title like ? escape '\\')
          order by newest.last_activity_at desc, newest.id limit 1)
        where automations.project_id in (${marks}))
      where true ${after.sql} ${ORDER} limit ?)`,
    args: [...search, ...projectIds, ...after.args, limit + 1],
  };
}

function parts(
  db: Db,
  projectIds: string[],
  search: [string, string],
  origin: "chat" | "automation" | null,
  before: FeedCursor | null,
  limit: number,
): Part[] {
  const running = place(before, 1);
  const rest = place(before, 0);
  const out: Part[] = [];
  // chats never carry an automation; a run whose automation is gone
  // has none left
  const kind =
    origin === null ? "automation_id is null" : `origin = '${origin}'`;
  const origins =
    origin === null ? (["chat", "automation"] as const) : [origin];
  for (const id of projectIds) {
    out.push(
      ...arm(
        "sessions_running",
        `project_id = ? and status = 'running' and ${kind}`,
        [id],
        search,
        running,
        limit,
      ),
    );
    for (const each of origins) {
      out.push(
        ...arm(
          "sessions_feed",
          `project_id = ? and origin = '${each}' and automation_id is null
            and status != 'running'`,
          [id],
          search,
          rest,
          limit,
        ),
      );
    }
  }
  if (origin === "chat") return out;
  if (origin === null) {
    return [...out, newestRuns(projectIds, search, before, limit)];
  }
  // a run's project is its automation's
  const marks = projectIds.map(() => "?").join(", ");
  const automations = db
    .query<{ id: string }, string[]>(
      `select id from automations where project_id in (${marks})`,
    )
    .all(...projectIds);
  for (const { id } of automations) {
    out.push(
      ...arm(
        "sessions_automation",
        "automation_id = ? and status != 'running'",
        [id],
        search,
        rest,
        limit,
      ),
    );
  }
  return out;
}

function feedOrder(a: RawSession, b: RawSession): number {
  const rank = Number(b.status === "running") - Number(a.status === "running");
  if (rank !== 0) return rank;
  if (a.last_activity_at !== b.last_activity_at) {
    return b.last_activity_at - a.last_activity_at;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The feed's first limit+1 rows after the cursor, in the feed order. */
export function feedRead(
  db: Db,
  ...[
    projectIds,
    q,
    origin = null,
    before = null,
    limit = STREAM_LIMIT,
  ]: ListArgs
): RawSession[] {
  if (projectIds.length === 0) return [];
  const search: [string, string] = [q, `%${q.replace(/[%_\\]/g, "\\$&")}%`];
  const all = parts(db, projectIds, search, origin, before, limit);
  const read: RawSession[] = [];
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    read.push(
      ...db
        .query<RawSession, (string | number)[]>(
          `select * from (${batch.map((part) => part.sql).join(" union all ")})
           ${ORDER} limit ?`,
        )
        .all(...batch.flatMap((part) => part.args), limit + 1),
    );
  }
  return all.length > BATCH ? read.sort(feedOrder).slice(0, limit + 1) : read;
}

// how many runs each automation keeps, what its line counts
function runCounts(db: Db, raws: RawSession[]): Map<string, number> {
  const ids = [...new Set(raws.flatMap((raw) => raw.automation_id ?? []))];
  if (ids.length === 0) return new Map();
  const marks = ids.map(() => "?").join(", ");
  const rows = db
    .query<{ id: string; n: number }, string[]>(
      `select automation_id as id, count(*) as n from sessions
       where automation_id in (${marks}) group by automation_id`,
    )
    .all(...ids);
  return new Map(rows.map((row) => [row.id, row.n]));
}

// one row past the page says whether another page follows, without a
// count that would be stale while rows arrive
export function listSessions(
  db: Db,
  usagePort: UsagePort,
  ...args: ListArgs
): SessionsResponse {
  const [, , origin = null, , limit = STREAM_LIMIT] = args;
  const read = feedRead(db, ...args);
  const rows = read.slice(0, limit);
  const last = rows.at(-1);
  const usage = usagePort.latestFor(rows.map((row) => row.id));
  return {
    rows: streamRows(
      db,
      rows,
      usage,
      origin === null ? runCounts(db, rows) : undefined,
    ),
    next: read.length > limit && last !== undefined ? feedCursor(last) : null,
  };
}
