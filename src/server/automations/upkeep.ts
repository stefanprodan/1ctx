// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The scheduler's work beside its fires: retention, the last run kept
// on the row, and a checked run's end.

import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { Checks } from "./check.ts";
import { type AutomationStore, automationChanged } from "./store.ts";

export type UpkeepDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  store: AutomationStore;
  sessions: SessionStore;
  checks: Checks;
};

export function sweepRuns(deps: UpkeepDeps): number {
  let count = 0;
  for (const session of deps.sessions.expiredRuns(deps.clock())) {
    try {
      transact(deps.db, () => {
        const deleted = deps.sessions.remove(session.id);
        if (deleted === null || deleted === "running") {
          return { result: undefined };
        }
        count++;
        return { result: undefined, events: [deleted] };
      });
    } catch (err) {
      deps.log.warn("retention delete failed", {
        chat: session.id,
        ...errorFields(err, false),
      });
    }
  }
  if (count > 0) deps.log.info("retention", { removed: count });
  return count;
}

export function reconcileRuns(deps: UpkeepDeps): number {
  let count = 0;
  for (const row of deps.store.all()) {
    if (row.lastRunSessionId === null) continue;
    const session = deps.sessions.byId(row.lastRunSessionId);
    if (session === null || session.status === "running") continue;
    transact(deps.db, () => {
      const updated = deps.store.recordRunEnd(
        row.id,
        session.id,
        session.status,
        deps.clock(),
      );
      if (updated === null) return { result: undefined };
      count++;
      return { result: undefined, events: [automationChanged(updated)] };
    });
  }
  return count;
}

export function onRunEnd(deps: UpkeepDeps, event: BusEvent): void {
  if (event.type !== "session.changed") return;
  const session = event.data.session;
  if (session.automationId === null || session.status === "running") return;
  try {
    transact(deps.db, () => {
      const updated = deps.store.recordRunEnd(
        session.automationId!,
        session.id,
        session.status,
        deps.clock(),
      );
      deps.checks.ended(session.id, () => {
        const cause = deps.sessions.lastSend(session.id)?.cause;
        return cause === "shutdown" || cause === "restart";
      });
      return {
        result: undefined,
        events: updated === null ? [] : [automationChanged(updated)],
      };
    });
  } catch (err) {
    deps.log.error("run record failed", {
      automation: session.automationId,
      ...errorFields(err),
    });
  }
}
