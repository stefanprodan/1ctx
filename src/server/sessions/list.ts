// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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

const ORDER = "order by status = 'running' desc, last_activity_at desc, id";

// All lists an automation once, as its newest run: the chats and the
// runs whose automation is gone, then per automation the newest run
// holding the query, found through its index. An automation never runs
// twice at once, so its running run is its newest by activity
function grouped(marks: string, after: string): string {
  return `select * from (
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
    where true ${after}
    ${ORDER} limit ?`;
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
  ...[
    projectIds,
    q,
    origin = null,
    before = null,
    limit = STREAM_LIMIT,
  ]: ListArgs
): SessionsResponse {
  if (projectIds.length === 0) return { rows: [], next: null };
  const marks = projectIds.map(() => "?").join(", ");
  const needle = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const after = feedAfter(before);
  const read =
    origin === null
      ? db
          .query<RawSession, (string | number)[]>(grouped(marks, after.sql))
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
          .query<RawSession, (string | number)[]>(
            `select * from sessions
             where project_id in (${marks})
               and (? = '' or title like ? escape '\\')
               and origin = ?
               ${after.sql}
             ${ORDER} limit ?`,
          )
          .all(...projectIds, q, needle, origin, ...after.args, limit + 1);
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
