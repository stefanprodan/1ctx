// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SessionsResponse } from "../../shared/api/sessions.ts";
import type { Db } from "../db/index.ts";
import {
  type FeedCursor,
  feedAfter,
  feedCursor,
  type RunsCursor,
} from "./cursor.ts";
import { feedRows } from "./feed.ts";
import type { RawSession, UsagePort } from "./rows.ts";
import { FEED_LIMIT } from "./rows.ts";

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

function arm(
  projects: string,
  origin: "chat" | "automation" | null,
  search: [string, string],
  before: FeedCursor | null,
  rank: 0 | 1 | null,
  limit: number,
): Part {
  const index = origin === null ? "sessions_feed_unowned" : "sessions_feed";
  const kind =
    origin === null ? "automation_id is null" : `origin = '${origin}'`;
  const at =
    before === null
      ? ""
      : "and last_activity_at <= ? and (last_activity_at < ? or id > ?)";
  const args = before === null ? [] : [before.at, before.at, before.id];
  const order = rank === null ? ORDER : "order by last_activity_at desc, id";
  return {
    sql: `select * from sessions indexed by ${index}
      where project_id in (select value from json_each(?)) and ${kind}
        ${SEARCH} ${rank === null ? "" : `and (status = 'running') = ${rank}`}
        ${at} ${order} limit ?`,
    args: [projects, ...search, ...args, limit],
  };
}

// A miss reads every retained run of each visible automation, so the
// index carries the order and the title: the walk never leaves it. The
// cursor applies after the choice, so a passed automation never returns.
function newestRuns(
  projects: string,
  search: [string, string],
  before: FeedCursor | null,
  limit: number,
): Part {
  const after = feedAfter(before);
  return {
    sql: `select * from (
        select sessions.* from automations
        join sessions on sessions.id = (
          select newest.id from sessions newest indexed by sessions_automation
          where newest.automation_id = automations.id
            and (? = '' or newest.title like ? escape '\\')
          order by newest.last_activity_at desc, newest.id limit 1)
        where automations.project_id in (select value from json_each(?)))
      where true ${after.sql} ${ORDER} limit ?`,
    args: [...search, projects, ...after.args, limit + 1],
  };
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
  ...[projectIds, q, origin = null, before = null, limit = FEED_LIMIT]: ListArgs
): RawSession[] {
  if (projectIds.length === 0) return [];
  const projects = JSON.stringify(projectIds);
  const search: [string, string] = [q, `%${q.replace(/[%_\\]/g, "\\$&")}%`];
  const read: RawSession[] = [];
  const run = (part: Part) => {
    read.push(
      ...db.query<RawSession, (string | number)[]>(part.sql).all(...part.args),
    );
  };
  // SQLite's ordered IN ranges stop each project once it cannot enter the top N.
  run(
    arm(projects, origin, search, before, before?.running ?? null, limit + 1),
  );
  if (before?.running === 1 && read.length <= limit) {
    run(arm(projects, origin, search, null, 0, limit + 1 - read.length));
  }
  if (origin === null) run(newestRuns(projects, search, before, limit));
  return origin === null ? read.sort(feedOrder).slice(0, limit + 1) : read;
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
  const [, , origin = null, , limit = FEED_LIMIT] = args;
  const read = feedRead(db, ...args);
  const rows = read.slice(0, limit);
  const last = rows.at(-1);
  const usage = usagePort.latestFor(rows.map((row) => row.id));
  return {
    rows: feedRows(
      db,
      rows,
      usage,
      origin === null ? runCounts(db, rows) : undefined,
    ),
    next: read.length > limit && last !== undefined ? feedCursor(last) : null,
  };
}

export type AlertArgs = [
  projectIds: string[],
  q: string,
  before?: RunsCursor | null,
  limit?: number,
];

// The Flagged pick: the automations with an open alert, newest
// alert first, through the partial index on attention_since, each as
// All's line, its newest run holding the search. The cursor is the
// alert's place: <since>.<automation id>
export function listAlerts(
  db: Db,
  usagePort: UsagePort,
  ...[projectIds, q, before = null, limit = FEED_LIMIT]: AlertArgs
): SessionsResponse {
  if (projectIds.length === 0) return { rows: [], next: null };
  const search: [string, string] = [q, `%${q.replace(/[%_\\]/g, "\\$&")}%`];
  const after =
    before === null
      ? { sql: "", args: [] }
      : {
          sql: `and (automations.attention_since < ?
            or (automations.attention_since = ? and automations.id > ?))`,
          args: [before.at, before.at, before.id],
        };
  const read = db
    .query<
      RawSession & { alert_since: number; alert_automation: string },
      (string | number)[]
    >(
      `select sessions.*, automations.attention_since as alert_since,
         automations.id as alert_automation
       from automations indexed by automations_attention
       join sessions on sessions.id = (
         select newest.id from sessions newest indexed by sessions_automation
         where newest.automation_id = automations.id
           and (? = '' or newest.title like ? escape '\\')
         order by newest.last_activity_at desc, newest.id limit 1)
       where automations.attention_since is not null
         and automations.project_id in (select value from json_each(?))
         ${after.sql}
       order by automations.attention_since desc, automations.id limit ?`,
    )
    .all(...search, JSON.stringify(projectIds), ...after.args, limit + 1);
  const rows = read
    .slice(0, limit)
    .map(({ alert_since: _, alert_automation: __, ...raw }) => raw);
  const last = read.at(limit - 1);
  const usage = usagePort.latestFor(rows.map((row) => row.id));
  return {
    rows: feedRows(db, rows, usage, runCounts(db, rows)),
    next:
      read.length > limit && last !== undefined
        ? `${last.alert_since}.${last.alert_automation}`
        : null,
  };
}
