// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AutomationRunsResponse,
  RunTally,
} from "../../shared/api/automations.ts";
import type { RunFilter } from "../../shared/words.ts";
import { SESSION_STATUSES } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { RawSession, SessionRow, UsagePort } from "./rows.ts";
import { STREAM_LIMIT, session } from "./rows.ts";
import { streamRows } from "./stream.ts";

export function automationRuns(
  db: Db,
  usage: UsagePort,
  automationId: string,
  filter: RunFilter | null,
  limit = STREAM_LIMIT,
): AutomationRunsResponse {
  const condition =
    filter === "failed"
      ? "and status = 'failed'"
      : filter === "manual"
        ? "and run_source = 'manual'"
        : "";
  const rows = db
    .query<RawSession, [string, number]>(
      `select * from sessions where automation_id = ? ${condition}
       order by last_activity_at desc, id limit ?`,
    )
    .all(automationId, limit);
  const tally = Object.fromEntries(
    SESSION_STATUSES.map((status) => [status, 0]),
  ) as RunTally;
  for (const row of db
    .query<{ status: keyof RunTally; n: number }, [string]>(
      `select status, count(*) as n from sessions
       where automation_id = ? group by status`,
    )
    .all(automationId)) {
    tally[row.status] = row.n;
  }
  return {
    rows: streamRows(db, rows, usage.latestFor(rows.map((row) => row.id))),
    tally,
  };
}

export function automationRunning(db: Db, automationId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        "select count(*) as n from sessions where automation_id = ? and status = 'running'",
      )
      .get(automationId)!.n > 0
  );
}

export function expiredAutomationRuns(
  db: Db,
  usage: UsagePort,
  now: number,
): SessionRow[] {
  const rows = db
    .query<RawSession, [number]>(
      `select sessions.* from sessions
       join automations on automations.id = sessions.automation_id
       where sessions.status != 'running'
         and sessions.last_activity_at <
           ? - automations.retention_days * 86400000
       order by sessions.last_activity_at, sessions.id`,
    )
    .all(now);
  const latest = usage.latestFor(rows.map((row) => row.id));
  return rows.map((raw) => session(raw, latest.get(raw.id) ?? null));
}
