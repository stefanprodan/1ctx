// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The external tasks entity's pure row rules: the order of the
// project's unfinished list, its closed pages and Home's marked tasks;
// a frame applied to what a project's page holds; and a first page of
// entries read again over the pages held.

import type {
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../shared/contracts/external-task.ts";
import type { ExternalTaskState } from "../../shared/words.ts";
import { searched } from "../lib/search.ts";

// the order a member acts in: what waits on them, what runs, what waits
// for a claim
const RANK: Record<ExternalTaskState, number> = {
  blocked: 0,
  claimed: 1,
  open: 2,
  done: 3,
  dropped: 3,
};

export const unfinished = (state: ExternalTaskState): boolean =>
  state === "open" || state === "claimed" || state === "blocked";

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function taskOrder(a: ExternalTaskRow, b: ExternalTaskRow): number {
  return RANK[a.state] - RANK[b.state] || b.movedAt - a.movedAt || byId(a, b);
}

// latest close first, as the closed pages are read
const closedOrder = (a: ExternalTaskRow, b: ExternalTaskRow) =>
  b.movedAt - a.movedAt || byId(a, b);

// latest mark first, as Home's section is read
const markOrder = (a: ExternalTaskRow, b: ExternalTaskRow) =>
  (b.attentionAt ?? 0) - (a.attentionAt ?? 0) || byId(a, b);

// the row into a list by the revision rule: a held row at or above the
// incoming revision keeps its word; a row the list no longer takes
// leaves it
function upsert(
  list: ExternalTaskRow[],
  row: ExternalTaskRow,
  takes: (row: ExternalTaskRow) => boolean,
  order: (a: ExternalTaskRow, b: ExternalTaskRow) => number,
): ExternalTaskRow[] {
  const held = list.find((t) => t.id === row.id);
  if (held !== undefined && held.revision >= row.revision) return list;
  const rest = list.filter((t) => t.id !== row.id);
  return takes(row) ? [...rest, row].sort(order) : rest;
}

export const upsertTask = (list: ExternalTaskRow[], row: ExternalTaskRow) =>
  upsert(list, row, (t) => unfinished(t.state), taskOrder);

// what the closed pages are read under: a search, trimmed when sent,
// and done or dropped, null for both
export type ClosedFilter = {
  q: string;
  state: "done" | "dropped" | null;
};

export const ALL_CLOSED: ClosedFilter = { q: "", state: null };

export const sameClosed = (a: ClosedFilter, b: ClosedFilter) =>
  a.q.trim() === b.q.trim() && a.state === b.state;

const present = (fields: (string | null | undefined)[]): string[] =>
  fields.filter((field): field is string => typeof field === "string");

// what the page's search matches in a current task
export const taskFields = (row: ExternalTaskRow): string[] =>
  present([row.title, row.part, row.createdBy?.username, row.claim?.username]);

// a frame's closed row under the server's search: its fields, a closed
// task holding no claim, by the server's ASCII-only case rule
export const closedTakes =
  (filter: ClosedFilter) =>
  (row: ExternalTaskRow): boolean =>
    !unfinished(row.state) &&
    (filter.state === null || row.state === filter.state) &&
    present([row.title, row.part, row.createdBy?.username]).some((field) =>
      searched(field, filter.q),
    );

export const closedUpsert =
  (filter: ClosedFilter) => (list: ExternalTaskRow[], row: ExternalTaskRow) =>
    upsert(list, row, closedTakes(filter), closedOrder);

export const upsertClosed = closedUpsert(ALL_CLOSED);

export const upsertMarked = (list: ExternalTaskRow[], row: ExternalTaskRow) =>
  upsert(list, row, (t) => t.attentionAt !== null, markOrder);

// a list's answer over the rows held: a held row the answer lists keeps
// its word while its revision is at or above the answer's
export function reconcile(
  held: ExternalTaskRow[],
  answer: ExternalTaskRow[],
): ExternalTaskRow[] {
  return answer.reduce(
    upsertTask,
    held.filter((t) => answer.some((a) => a.id === t.id)),
  );
}

// the closed pages read so far under the filter
export type ClosedPages = { rows: ExternalTaskRow[]; next: string | null };

// what a project's page holds: every unfinished task, the closed count,
// and the closed pages read so far, null while the first is out
export type TaskLists = {
  tasks: ExternalTaskRow[];
  closed: number;
  pages: ClosedPages | null;
};

// a frame's row into the lists. The unfinished list is whole, so a row
// it lacks was closed or is new; a new one has no entry yet, and a
// reopen writes one. A closed row is placed only above the paging
// cursor, since one past it is read with its page, and only when the
// filter the pages were read under takes it.
export function applyTask(
  lists: TaskLists,
  row: ExternalTaskRow,
  filter: ClosedFilter = ALL_CLOSED,
): TaskLists {
  const open = lists.tasks.find((t) => t.id === row.id);
  const shut = lists.pages?.rows.find((t) => t.id === row.id);
  const held = open ?? shut;
  if (held !== undefined && held.revision >= row.revision) return lists;
  const tasks = upsertTask(lists.tasks, row);
  let closed = lists.closed;
  if (unfinished(row.state)) {
    if (shut !== undefined || (open === undefined && row.entries > 0)) {
      closed = Math.max(0, closed - 1);
    }
  } else if (open !== undefined) {
    closed++;
  }
  let pages = lists.pages;
  if (pages !== null) {
    const last = pages.rows.at(-1);
    const above =
      shut !== undefined ||
      pages.next === null ||
      (last !== undefined && closedOrder(row, last) < 0);
    if (above || unfinished(row.state)) {
      pages = { ...pages, rows: closedUpsert(filter)(pages.rows, row) };
    }
  }
  return { tasks, closed, pages };
}

// a deleted task out of the lists; one held in neither was closed,
// since the unfinished list is whole
export function dropTask(lists: TaskLists, id: string): TaskLists {
  const open = lists.tasks.some((t) => t.id === id);
  return {
    tasks: lists.tasks.filter((t) => t.id !== id),
    closed: open ? lists.closed : Math.max(0, lists.closed - 1),
    pages:
      lists.pages === null
        ? null
        : { ...lists.pages, rows: lists.pages.rows.filter((t) => t.id !== id) },
  };
}

// Home's marked tasks and how many are marked in all
export type Marked = { tasks: ExternalTaskRow[]; count: number };

export function applyMarked(marked: Marked, row: ExternalTaskRow): Marked {
  const held = marked.tasks.find((t) => t.id === row.id);
  if (held !== undefined && held.revision >= row.revision) return marked;
  const tasks = upsertMarked(marked.tasks, row);
  const was = held !== undefined;
  const is = row.attentionAt !== null;
  // a marked row not held may be one past the rows read; it is counted
  // once it is seen marked, and leaves the count only once held
  const count = marked.count + (is && !was ? 1 : 0) - (!is && was ? 1 : 0);
  return { tasks, count: Math.max(count, tasks.length) };
}

export function dropMarked(marked: Marked, id: string): Marked {
  if (!marked.tasks.some((t) => t.id === id)) return marked;
  return {
    tasks: marked.tasks.filter((t) => t.id !== id),
    count: Math.max(0, marked.count - 1),
  };
}

// a first page of entries read again over the pages held, newest first.
// Entries are only ever added, so a held entry the page lacks is older
// than it; when the page's oldest is held the older pages stay,
// else a gap lies between and the page starts over
export function mergeEntries(
  held: { entries: ExternalTaskEntry[]; next: string | null },
  page: { entries: ExternalTaskEntry[]; next: string | null },
): { entries: ExternalTaskEntry[]; next: string | null } {
  const oldest = page.entries.at(-1);
  if (page.next === null || oldest === undefined) return page;
  const at = held.entries.findIndex((e) => e.id === oldest.id);
  if (at === -1) return page;
  return {
    entries: [...page.entries, ...held.entries.slice(at + 1)],
    next: held.next,
  };
}

// a later page after the entries held, never repeating one
export function appendEntries(
  held: ExternalTaskEntry[],
  page: ExternalTaskEntry[],
): ExternalTaskEntry[] {
  const ids = new Set(held.map((e) => e.id));
  return [...held, ...page.filter((e) => !ids.has(e.id))];
}
