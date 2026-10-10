// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationAlert } from "../../shared/contracts/automation.ts";
import { ATTENTION_AT } from "../../shared/contracts/decision.ts";
import type { Db } from "../db/index.ts";

// a literal, as the partial index sessions_marked is written, or SQLite
// cannot use it
export const MARKED = `attention >= ${ATTENTION_AT}`;

// the marked runs of the automations row's open alert, as marked
export const openAlertRuns = (automations: string) =>
  `from sessions marked indexed by sessions_marked
     where marked.automation_id = ${automations}.id and marked.${MARKED}
       and marked.last_activity_at >= ${automations}.attention_since`;

const alertRuns = (automations: string, pick: string, where = "") =>
  `(select ${pick} ${openAlertRuns(automations)}${where}
     order by marked.last_activity_at desc, marked.id limit 1)`;

// the alert's columns of the automations row named, nothing read while
// none is open
export const alertColumns = (automations: string) =>
  `${automations}.attention_since as alert_since,
   case when ${automations}.attention_since is null then 0 else
     (select count(*) ${openAlertRuns(automations)})
   end as alert_runs,
   case when ${automations}.attention_since is null then null else
     ${alertRuns(
       automations,
       "marked.attention_reason",
       " and marked.attention_reason is not null",
     )}
   end as alert_reason,
   case when ${automations}.attention_since is null then null else
     ${alertRuns(automations, "marked.attention_by")}
   end as alert_by`;

export type RawAlert = {
  alert_since: number | null;
  alert_runs: number;
  alert_reason: string | null;
  alert_by: string | null;
};

export const alertOf = (raw: RawAlert): AutomationAlert | null =>
  raw.alert_since === null
    ? null
    : {
        since: raw.alert_since,
        runs: raw.alert_runs,
        reason: raw.alert_reason,
        by: raw.alert_by,
      };

// a run a stop, shutdown or restart ended said nothing; in a 1 ms tie a
// mark wins
export function endedAfter(
  db: Db,
  automationId: string,
  sessionId: string,
  at: number,
  tie: boolean,
): boolean {
  return (
    db
      .query<{ n: number }, [string, number, string]>(
        `select count(*) as n from (select 1 from sessions
           indexed by sessions_automation
           where automation_id = ? and last_activity_at ${tie ? ">=" : ">"} ?
             and status != 'running' and id != ?
             and not exists (select 1 from sends
               where sends.session_id = sessions.id
                 and sends.cause in ('stop', 'shutdown', 'restart'))
           limit 1)`,
      )
      .get(automationId, at, sessionId)!.n > 0
  );
}

// What a run's delete changes on its automation, null for a session
// that is no run: a marked run may change the open alert, and a run the
// row names as its last or once run is cleared from it by the foreign
// key, which moves no revision. Two lookups by key.
export type DeletedRun = {
  automationId: string;
  endedAt: number;
  marked: boolean;
  named: boolean;
};

export function deletedRun(db: Db, sessionId: string): DeletedRun | null {
  const row = db
    .query<
      {
        automation_id: string;
        last_activity_at: number;
        marked: number;
        named: number;
      },
      [string]
    >(
      `select sessions.automation_id, sessions.last_activity_at,
         coalesce(sessions.${MARKED}, 0) as marked,
         coalesce(automations.last_run_session_id = sessions.id, 0)
           or coalesce(automations.once_run_session_id = sessions.id, 0)
           as named
       from sessions join automations on automations.id = sessions.automation_id
       where sessions.id = ?`,
    )
    .get(sessionId);
  return row === null
    ? null
    : {
        automationId: row.automation_id,
        endedAt: row.last_activity_at,
        marked: row.marked === 1,
        named: row.named === 1,
      };
}
