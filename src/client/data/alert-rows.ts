// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of the feed's Flagged pick: the automations
// with an open alert, one line each, newest alert first, as the server
// lists them. A run's envelope carries its automation's alert, so an
// alert that opens places the line and one that closes drops it, and an
// automation frame drops it on a dismiss. Only what the server alone can
// place, a run off the search or a row it could not read, asks for the
// first page again.

import type { FeedRow } from "../../shared/api/sessions.ts";
import type {
  AutomationAlert,
  AutomationSummary,
} from "../../shared/contracts/automation.ts";
import {
  type Change,
  type Reconciled,
  type RowEnvelope,
  searched,
} from "./sessions-rows.ts";

// two words on an alert alike, by value, as frames and rows carry copies
export const sameAlert = (
  a: AutomationAlert | null | undefined,
  b: AutomationAlert | null | undefined,
): boolean =>
  a === b ||
  (a != null &&
    b != null &&
    a.since === b.since &&
    a.runs === b.runs &&
    a.reason === b.reason);

// the automation a line stands for
const lineOf = (row: FeedRow) => row.automation?.id ?? row.session.automationId;

const sinceOf = (row: FeedRow) => row.automation?.alert?.since ?? 0;

// newest alert first, then the automation's id, as the route orders
export function alertOrder(a: FeedRow, b: FeedRow): number {
  const since = sinceOf(b) - sinceOf(a);
  if (since !== 0) return since;
  const x = lineOf(a) ?? "";
  const y = lineOf(b) ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

export const byAlert = (rows: FeedRow[]): FeedRow[] =>
  [...rows].sort(alertOrder);

// the place the pick's cursor names, <since>.<automation id>; null for
// anything else
export function alertPlace(
  cursor: string,
): { since: number; id: string } | null {
  const [since, id, ...rest] = cursor.split(".");
  if (rest.length > 0 || since === undefined || id === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(since) || id === "") return null;
  return { since: Number(since), id };
}

// whether a line sits past the cursor, where a later page brings it
function past(row: FeedRow, next: string | null): boolean {
  if (next === null) return false;
  const edge = alertPlace(next);
  if (edge === null) return true;
  const since = sinceOf(row);
  if (since !== edge.since) return since < edge.since;
  return (lineOf(row) ?? "") > edge.id;
}

// a later page into the held lines: one per automation, the newer run's
// or, of one run, the higher revision's
export function mergeAlertPage(held: FeedRow[], answer: FeedRow[]): FeedRow[] {
  const lines = new Map<string, FeedRow>();
  for (const row of [...held, ...answer]) {
    const id = lineOf(row);
    if (id === null) continue;
    const mine = lines.get(id);
    const newer =
      mine === undefined ||
      row.session.createdAt > mine.session.createdAt ||
      (row.session.id === mine.session.id &&
        row.session.revision > mine.session.revision);
    if (newer) lines.set(id, row);
  }
  return byAlert([...lines.values()]);
}

// a warm first page over the held lines, as refreshHead() for the other
// picks: the answer is the head, a held copy of the same run at a higher
// revision keeping its word, and the held lines strictly past the
// answer's last are the tail, paged by the held cursor
export function refreshAlertHead(
  held: FeedRow[],
  answer: { rows: FeedRow[]; next: string | null },
  next: string | null,
): { rows: FeedRow[]; next: string | null } {
  const mine = new Map(held.map((row) => [row.session.id, row]));
  const head = answer.rows.map((row) => {
    const copy = mine.get(row.session.id);
    return copy !== undefined && copy.session.revision > row.session.revision
      ? copy
      : row;
  });
  const last = answer.rows.at(-1);
  const inHead = new Set(answer.rows.map(lineOf));
  const tail =
    answer.next === null || last === undefined
      ? []
      : held.filter(
          (row) => !inHead.has(lineOf(row)) && alertOrder(row, last) > 0,
        );
  return {
    rows: byAlert([...head, ...tail]),
    next: tail.length > 0 ? next : answer.next,
  };
}

// a run's envelope over the lines: its automation's alert as the row
// read it after the commit places, moves or drops the line
export function reconcileAlert(
  rows: FeedRow[],
  next: string | null,
  q: string,
  ev: RowEnvelope,
): Reconciled {
  const same = (out: FeedRow[]) => ({ rows: out, reload: false });
  const { session } = ev;
  const id = session.automationId;
  if (session.origin !== "automation" || id === null) return same(rows);
  const held = rows.find((row) => lineOf(row) === id);
  if (ev.row === null) return { rows, reload: held !== undefined };
  const automation = ev.row.automation;
  if (automation === null || automation.alert === null) {
    return same(held === undefined ? rows : rows.filter((r) => r !== held));
  }
  const listed = q === "" || searched(session.title, q);
  if (held !== undefined) {
    const own = held.session.id === session.id;
    if (own && held.session.revision >= session.revision) {
      return same(rows);
    }
    const newer = own || session.createdAt > held.session.createdAt;
    // the line stands for the newest run holding the search, which only
    // the server knows once this one does not
    if (newer && !listed) return { rows, reload: true };
    const line: FeedRow = newer
      ? {
          ...ev.row,
          session,
          runs: own || held.runs === null ? held.runs : held.runs + 1,
        }
      : { ...held, automation };
    return same(byAlert([...rows.filter((r) => r !== held), line]));
  }
  if (!listed) return { rows, reload: true };
  const line: FeedRow = { ...ev.row, session, runs: null };
  if (past(line, next)) return same(rows);
  return same(byAlert([...rows, line]));
}

// an automation frame over the lines: its alert closed drops its line,
// a moved one moves it; a line not held comes with its run's envelope
export function alertFrame(
  rows: FeedRow[],
  automation: Pick<AutomationSummary, "id" | "name" | "alert">,
): FeedRow[] {
  const held = rows.find((row) => lineOf(row) === automation.id);
  if (held === undefined) return rows;
  if (automation.alert === null) return rows.filter((r) => r !== held);
  const label = held.automation;
  if (
    sameAlert(label?.alert, automation.alert) &&
    label?.name === automation.name
  ) {
    return rows;
  }
  const line: FeedRow = {
    ...held,
    automation: {
      id: automation.id,
      name: automation.name,
      alert: automation.alert,
    },
  };
  return byAlert([...rows.filter((r) => r !== held), line]);
}

// the changes over a first page read before them, as replay() does for
// the other picks
export function replayAlerts(
  answer: FeedRow[],
  next: string | null,
  q: string,
  changes: Change[],
): { rows: FeedRow[]; reload: boolean } {
  let rows = answer;
  let reload = false;
  for (const change of changes) {
    if ("drop" in change) {
      const kept = rows.filter((row) => !change.drop(row));
      if (kept.length !== rows.length) rows = kept;
      continue;
    }
    const out = reconcileAlert(rows, next, q, change.ev);
    reload ||= out.reload;
    rows = out.rows;
  }
  return { rows, reload };
}
