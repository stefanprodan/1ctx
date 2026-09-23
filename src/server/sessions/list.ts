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
  const read = db
    .query<RawSession, (string | number | null)[]>(
      `select * from sessions
       where project_id in (${marks})
         and (? = '' or title like ? escape '\\')
         and (? is null or origin = ?)
         ${after.sql}
       order by status = 'running' desc, last_activity_at desc, id
       limit ?`,
    )
    .all(...projectIds, q, needle, origin, origin, ...after.args, limit + 1);
  const rows = read.slice(0, limit);
  const last = rows.at(-1);
  const usage = usagePort.latestFor(rows.map((row) => row.id));
  return {
    rows: streamRows(db, rows, usage),
    next: read.length > limit && last !== undefined ? feedCursor(last) : null,
  };
}
