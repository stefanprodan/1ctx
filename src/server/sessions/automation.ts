// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { StreamRow } from "../../shared/api/sessions.ts";
import type { Db } from "../db/index.ts";
import type { RawSession, SessionRow, UsagePort } from "./rows.ts";
import { STREAM_LIMIT, session } from "./rows.ts";
import { streamRows } from "./stream.ts";

export function automationRuns(
  db: Db,
  usage: UsagePort,
  automationId: string,
  limit = STREAM_LIMIT,
): StreamRow[] {
  const rows = db
    .query<RawSession, [string, number]>(
      `select * from sessions where automation_id = ?
       order by last_activity_at desc, id limit ?`,
    )
    .all(automationId, limit);
  return streamRows(db, rows, usage.latestFor(rows.map((row) => row.id)));
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
