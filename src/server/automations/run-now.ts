// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Run now on a checked automation (docs/automations.md, The check): its
// GET before the start, and the answer's validators held for its run.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import { Conflict, ServiceUnavailable } from "../lib/errors.ts";
import type { PreparedRun } from "../runner/index.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import type { Checks, Held } from "./check.ts";
import { type FireDeps, manualFor } from "./fire-event.ts";

type Deps = FireDeps & { sessions: SessionStore; checks: Checks };

// the refusals a GET would be wasted on; the start checks them again
export async function askNow(
  deps: Deps,
  row: AutomationSummary,
  user: UserRow,
  draining: boolean,
): Promise<Held | undefined> {
  if (row.checkUrl === null) return undefined;
  manualFor(deps, row, user);
  if (deps.sessions.runningAutomation(row.id)) {
    throw new Conflict("still running");
  }
  if (draining) throw new ServiceUnavailable("restarting");
  const held = await deps.checks.now(row);
  if (held === null) throw new ServiceUnavailable("restarting");
  return held;
}

// in the start's transaction: the answer belongs to the row it asked for
export function changedSince(
  row: AutomationSummary,
  held: Held | undefined,
): void {
  if (
    row.checkUrl !== (held?.url ?? null) ||
    (held !== undefined && row.editRevision !== held.editRevision)
  ) {
    throw new Conflict("automation changed, try again");
  }
}

// a new answer's validators wait for the run's end, as a fire's do
export function holding(
  checks: Checks,
  run: PreparedRun,
  automationId: string,
  held: Held | undefined,
): PreparedRun {
  if (held?.answer.result !== "200") return run;
  return {
    ...run,
    launch() {
      checks.hold(run.detail.session.id, automationId, held);
      run.launch();
    },
  };
}
