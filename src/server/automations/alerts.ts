// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One open alert per automation: attention_since, set by the end of a
// run with a mark and cleared by a clean one or a dismiss, each in the
// transaction of the write that causes it. A decider's word comes after
// its run ended, so a word on a run older than the automation's last
// ended one changes nothing: the newer run already said.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import { ATTENTION_AT } from "../../shared/contracts/decision.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { AlertChange } from "../runner/index.ts";
import { endedAfter, MARKED, type SessionStore } from "../sessions/index.ts";
import type { AutomationStore } from "./store.ts";

export type AlertsDeps = {
  db: Db;
  store: AutomationStore;
  sessions: Pick<SessionStore, "byId">;
  // the decider's chance on a run, in the caller's transaction
  markAttention(sessionId: string, attention: number, by: string): boolean;
};

export type Alerts = {
  runEnded(
    run: { automationId: string; sessionId: string; endedAt: number },
    change: AlertChange,
  ): BusEvent[];
  decided(sessionId: string, attention: number, by: string): boolean;
  undecided(sessionId: string): void;
  // the caller's transaction: closed, the summary and its events
  dismiss(id: string): { automation: AutomationSummary; events: BusEvent[] };
  // in the caller's transaction, after a marked run of it that ended at
  // endedAt was deleted: closed when no marked run of the open alert is
  // left, else one run fewer when the run was one of them
  pruned(id: string, endedAt: number): BusEvent[];
};

// the alert opens at a flagged run's end, once: false when one is open
const openAlert = (db: Db, id: string, since: number) =>
  db
    .query(
      `update automations set attention_since = ?, revision = revision + 1
       where id = ? and attention_since is null`,
    )
    .run(since, id).changes > 0;

// a run joined the open alert: its count and reason moved, so the
// summary's revision does
const touchAlert = (db: Db, id: string) =>
  db
    .query(
      `update automations set revision = revision + 1
       where id = ? and attention_since is not null`,
    )
    .run(id);

// a run of the open alert was deleted: its count and maybe its reason
// moved; false when the run ended before the alert opened
const touchSince = (db: Db, id: string, endedAt: number) =>
  db
    .query(
      `update automations set revision = revision + 1
       where id = ? and attention_since <= ?`,
    )
    .run(id, endedAt).changes > 0;

// a clean run or a dismiss: false when none was open
const closeAlert = (db: Db, id: string) =>
  db
    .query(
      `update automations set attention_since = null, revision = revision + 1
       where id = ? and attention_since is not null`,
    )
    .run(id).changes > 0;

// an open alert whose marked runs are all gone: one covering lookup
const closeEmpty = (db: Db, id: string) =>
  db
    .query(
      `update automations set attention_since = null, revision = revision + 1
       where id = ? and attention_since is not null and not exists (
         select 1 from sessions marked indexed by sessions_marked
         where marked.automation_id = automations.id and marked.${MARKED}
           and marked.last_activity_at >= automations.attention_since)`,
    )
    .run(id).changes > 0;

const changed = (automation: AutomationSummary): BusEvent => ({
  type: "automation.changed",
  data: { projectId: automation.projectId, automation },
});

export function alerts(deps: AlertsDeps): Alerts {
  const { db, store } = deps;

  const runEnded: Alerts["runEnded"] = (run, change) => {
    const tie = change === "close";
    if (endedAfter(db, run.automationId, run.sessionId, run.endedAt, tie)) {
      return [];
    }
    if (change === "close") {
      if (!closeAlert(db, run.automationId)) return [];
      const row = store.byId(run.automationId);
      return row === null ? [] : [changed(row)];
    }
    const opened = openAlert(db, run.automationId, run.endedAt);
    if (!opened) touchAlert(db, run.automationId);
    const row = store.byId(run.automationId);
    if (row === null) return [];
    if (!opened) return [changed(row)];
    return [
      changed(row),
      {
        type: "automation.attention",
        data: {
          projectId: row.projectId,
          automationId: row.id,
          sessionId: run.sessionId,
          since: run.endedAt,
        },
      },
    ];
  };

  // a run's later word, read where its row says it ended
  const settle = (sessionId: string, change: AlertChange) => {
    const run = deps.sessions.byId(sessionId);
    if (run === null || run.automationId === null) return [];
    return runEnded(
      {
        automationId: run.automationId,
        sessionId,
        endedAt: run.lastActivityAt,
      },
      change,
    );
  };

  return {
    runEnded,
    decided: (sessionId, attention, by) =>
      transact(db, () => {
        if (!deps.markAttention(sessionId, attention, by)) {
          return { result: false };
        }
        const change = attention >= ATTENTION_AT ? "open" : "close";
        return { result: true, events: settle(sessionId, change) };
      }),
    undecided: (sessionId) =>
      transact(db, () => ({
        result: undefined,
        events: settle(sessionId, "close"),
      })),
    pruned(id, endedAt) {
      if (!closeEmpty(db, id) && !touchSince(db, id, endedAt)) return [];
      const row = store.byId(id);
      return row === null ? [] : [changed(row)];
    },
    dismiss(id) {
      const closed = closeAlert(db, id);
      const automation = store.byId(id)!;
      return { automation, events: closed ? [changed(automation)] : [] };
    },
  };
}
