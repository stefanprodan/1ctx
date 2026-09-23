// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The automations entity's pure row rules: where a row goes in a list
// and which runs a filter shows.

import type { StreamRow } from "../../shared/api/sessions.ts";
import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { RunFilter } from "../../shared/words.ts";
import { ordered, runOrder } from "./sessions-rows.ts";

const byName = (a: AutomationSummary, b: AutomationSummary) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// the row into the list by the revision rule: a held row at or above
// the incoming revision keeps its word
export function upsertAutomation(
  list: AutomationSummary[],
  row: AutomationSummary,
): AutomationSummary[] {
  const held = list.find((a) => a.id === row.id);
  if (held !== undefined && held.revision >= row.revision) return list;
  return [...list.filter((a) => a.id !== row.id), row].sort(byName);
}

// whether a run belongs under a filter
export function matchesFilter(
  row: Pick<StreamRow, "session">,
  filter: RunFilter | null,
): boolean {
  if (filter === "failed") return row.session.status === "failed";
  if (filter === "manual") return row.session.runSource === "manual";
  return true;
}

// a run's envelope into the held runs: a held row moves when the
// revision is above its own, in the server's order of the runs
export function upsertRun(rows: StreamRow[], next: StreamRow): StreamRow[] {
  const held = rows.find((r) => r.session.id === next.session.id);
  if (held !== undefined && held.session.revision >= next.session.revision) {
    return rows;
  }
  return ordered(
    [...rows.filter((r) => r.session.id !== next.session.id), next],
    runOrder,
  );
}
