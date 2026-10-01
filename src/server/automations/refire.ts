// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// At start, the automations that ask to run again what a restart cut:
// those whose last run's send ended with cause shutdown (the drain's
// end) or restart (a crash, ended by repair). The list is memory only,
// so a second restart before a row fires finds the cut run still last
// and lists it again. The pass fires each as due now with source
// restart, through the checks and the cap waits of a scheduled fire.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { AutomationStore } from "./store.ts";

// the cut run, which must still be the row's last when it fires, and
// when it was listed, the restart run's due time
export type Cut = { sessionId: string; listedAt: number };

export function cutRuns(
  deps: { store: AutomationStore; sessions: Pick<SessionStore, "lastSend"> },
  now: number,
): Map<string, Cut> {
  const cut = new Map<string, Cut>();
  for (const row of deps.store.all()) {
    if (!row.rerunOnRestart || row.lastRunSessionId === null) continue;
    const cause = deps.sessions.lastSend(row.lastRunSessionId)?.cause;
    if (cause !== "shutdown" && cause !== "restart") continue;
    cut.set(row.id, { sessionId: row.lastRunSessionId, listedAt: now });
  }
  return cut;
}

// a suspend, the flag turned off, or a later run whatever its end,
// leaves the cut one alone
export function stillCut(
  row: AutomationSummary,
  listed: Cut | undefined,
): boolean {
  return (
    row.suspendedAt === null &&
    row.rerunOnRestart &&
    listed !== undefined &&
    row.lastRunSessionId === listed.sessionId
  );
}

// the pass's fires: the due rows, oldest first, then the listed rows
// not due, which are due now; a listed row since deleted leaves the list
export function withCut(
  due: AutomationSummary[],
  cut: Map<string, Cut>,
  store: Pick<AutomationStore, "byId">,
): AutomationSummary[] {
  const listed = new Set(due.map((row) => row.id));
  const rows = [...due];
  for (const id of [...cut.keys()]) {
    if (listed.has(id)) continue;
    const row = store.byId(id);
    if (row === null) cut.delete(id);
    else rows.push(row);
  }
  return rows;
}
