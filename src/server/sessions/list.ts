// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { StreamRow } from "../../shared/api/sessions.ts";
import type { Db } from "../db/index.ts";
import type { RawSession, UsagePort } from "./rows.ts";
import { STREAM_LIMIT } from "./rows.ts";
import { streamRows } from "./stream.ts";

export function listSessions(
  db: Db,
  usagePort: UsagePort,
  projectIds: string[],
  q: string,
  origin: "chat" | "automation" | null,
  limit = STREAM_LIMIT,
): StreamRow[] {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => "?").join(", ");
  const needle = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const rows = db
    .query<RawSession, (string | number | null)[]>(
      `select * from sessions
       where project_id in (${marks})
         and (? = '' or title like ? escape '\\')
         and (? is null or origin = ?)
       order by status = 'running' desc, last_activity_at desc, id
       limit ?`,
    )
    .all(...projectIds, q, needle, origin, origin, limit);
  const usage = usagePort.latestFor(rows.map((row) => row.id));
  return streamRows(db, rows, usage);
}
