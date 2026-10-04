// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AutomationRunsResponse,
  RunTally,
} from "../../shared/api/automations.ts";
import type { RunFilter } from "../../shared/words.ts";
import { SESSION_STATUSES } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { DAY_MS } from "../lib/clock.ts";
import { MARKED } from "./alerts.ts";
import { type RunsCursor, runsAfter, runsCursor } from "./cursor.ts";
import { feedRows } from "./feed.ts";
import type { RawSession, SessionRow, UsagePort } from "./rows.ts";
import { FEED_LIMIT, session } from "./rows.ts";

export type RunsArgs = [
  automationId: string,
  filter?: RunFilter | null,
  before?: RunsCursor | null,
  limit?: number,
];

export function automationRuns(
  db: Db,
  usage: UsagePort,
  ...[automationId, filter = null, before = null, limit = FEED_LIMIT]: RunsArgs
): AutomationRunsResponse {
  const condition =
    filter === "manual"
      ? "and run_source = 'manual'"
      : filter === "attention"
        ? `and ${MARKED}`
        : "";
  const after = runsAfter(before);
  const read = db
    .query<RawSession, (string | number)[]>(
      `select * from sessions where automation_id = ? ${condition}
       ${after.sql}
       order by last_activity_at desc, id limit ?`,
    )
    .all(automationId, ...after.args, limit + 1);
  const rows = read.slice(0, limit);
  const last = rows.at(-1);
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
    rows: feedRows(db, rows, usage.latestFor(rows.map((row) => row.id))),
    tally,
    next: read.length > limit && last !== undefined ? runsCursor(last) : null,
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
      // per automation, a seek to its expired runs: without stats SQLite
      // would otherwise walk every run in index order and read each row
      `select sessions.* from automations
       cross join sessions on sessions.automation_id = automations.id
       where sessions.status != 'running'
         and sessions.last_activity_at <
           ? - automations.retention_days * ${DAY_MS}
       order by sessions.last_activity_at, sessions.id`,
    )
    .all(now);
  const latest = usage.latestFor(rows.map((row) => row.id));
  return rows.map((raw) => session(raw, latest.get(raw.id) ?? null));
}
