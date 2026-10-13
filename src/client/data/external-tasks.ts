// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// External tasks: one project's unfinished list, loaded whole, and its
// closed pages under a search and a state, read by the server a page at
// a time; a changed filter starts again from the first. A task's page
// and the writes are data/external-task.ts, Home's waiting tasks
// data/waiting-tasks.ts. The socket's frames keep the lists current by
// the revision rule; a frame the client cannot place, or a label rename
// or delete, asks for one trailing read. An answer is kept only for the
// user and the turn it was asked for.

import { effect, signal } from "@preact/signals";
import type {
  ClosedTasksResponse,
  ExternalTasksResponse,
} from "../../shared/api/external-tasks.ts";
import type { ExternalTaskRow } from "../../shared/contracts/external-task.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import {
  ALL_CLOSED,
  applyTask,
  type ClosedFilter,
  type ClosedPages,
  dropTask,
  readClosedRow,
  reconcile,
  sameClosed,
  type TaskLists,
  unfinished,
  upsertClosed,
} from "./external-tasks-rows.ts";
import { Flight } from "./flight.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

// the project's unfinished tasks, null while not loaded
export const externalTasks = signal<ExternalTaskRow[] | null>(null);
export const externalTasksError = signal<Failure | null>(null);
// how many are done or canceled, so the card shows only while some are
export const closedCount = signal(0);
// what the closed pages are read under
export const closedFilter = signal<ClosedFilter>(ALL_CLOSED);
// the closed pages read so far, null while the first is out
export const closedPages = signal<ClosedPages | null>(null);
export const closedMore = signal<{ loading: boolean; error: Failure | null }>({
  loading: false,
  error: null,
});
// the hours a claim goes without a report before it is unclaimed
export const idleHours = signal<number | null>(null);

let owner: string | null = null;
let projectFor: string | null = null;
const kept = new Held<{
  tasks: ExternalTaskRow[];
  closed: number;
  idle: number | null;
}>();
let listTurn = 0;
let closedTurn = 0;
// frames that moved what a list read answers (a close, a reopen, any
// frame while no list is held), and closes, so a read out across one
// is asked again
let listMoves = 0;
let closes = 0;
// label renames and deletes of the project held, so a read out across
// one, a first one too, is asked again
let relabels = 0;
// the highest revision applied per task, so an answer read before a
// move never brings back what the task was
const latest = new Map<string, number>();
// deleted tasks: a row read before its delete never joins again
const gone = new Set<string>();
const idle = { loading: false, error: null };
// the reads are hoisted, so the flights exist before the user effect runs
const listFlight = new Flight(reloadList);
const closedFlight = new Flight(reloadClosed);

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  projectFor = null;
  kept.clear();
  latest.clear();
  gone.clear();
  listTurn++;
  closedTurn++;
  listFlight.stop();
  closedFlight.stop();
  externalTasks.value = null;
  externalTasksError.value = null;
  closedCount.value = 0;
  closedFilter.value = ALL_CLOSED;
  closedPages.value = null;
  closedMore.value = idle;
  idleHours.value = null;
});

// the tab's count, null while the project's list is not the one held
export function externalTaskCount(projectId: string): number | null {
  const list = externalTasks.value;
  return list === null || projectFor !== projectId ? null : list.length;
}

export const latestOf = (id: string): number => latest.get(id) ?? -1;
export const isGone = (id: string): boolean => gone.has(id);

const listPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/external-tasks`;

const listsHeld = (): TaskLists | null =>
  externalTasks.value === null
    ? null
    : {
        tasks: externalTasks.value,
        closed: closedCount.value,
        pages: closedPages.value,
      };

function setLists(lists: TaskLists): void {
  externalTasks.value = lists.tasks;
  closedCount.value = lists.closed;
  closedPages.value = lists.pages;
}

async function reloadList(): Promise<void> {
  if (projectFor !== null) await loadExternalTasks(projectFor);
}

export async function loadExternalTasks(projectId: string): Promise<void> {
  const forUser = owner;
  const turn = ++listTurn;
  if (projectFor !== projectId) {
    if (projectFor !== null && externalTasks.value !== null) {
      kept.set(projectFor, {
        tasks: externalTasks.value,
        closed: closedCount.value,
        idle: idleHours.value,
      });
    }
    const held = kept.get(projectId);
    externalTasks.value = held?.tasks ?? null;
    closedCount.value = held?.closed ?? 0;
    idleHours.value = held?.idle ?? null;
    closedFilter.value = ALL_CLOSED;
    closedPages.value = null;
    closedMore.value = idle;
    closedTurn++;
    listFlight.stop();
    closedFlight.stop();
  }
  projectFor = projectId;
  externalTasksError.value = null;
  const moves = listMoves;
  const labeled = relabels;
  try {
    const body = await api<ExternalTasksResponse>(listPath(projectId));
    if (owner !== forUser || listTurn !== turn) return;
    const held = externalTasks.value ?? [];
    // a row that left the list since it was asked stays out
    const answer = body.tasks.filter((t) => {
      const seen = latest.get(t.id);
      return (
        !gone.has(t.id) &&
        (seen === undefined ||
          t.revision >= seen ||
          held.some((h) => h.id === t.id))
      );
    });
    externalTasks.value = reconcile(held, answer);
    closedCount.value = body.closed;
    idleHours.value = body.idleHours;
    // a frame the answer may predate: the count or a row is the older
    // word, so one more read settles it
    if (
      listMoves !== moves ||
      relabels !== labeled ||
      body.tasks.some((t) => latestOf(t.id) > t.revision)
    ) {
      listFlight.ask();
    }
  } catch (err) {
    if (owner === forUser && listTurn === turn) {
      externalTasksError.value = failure(err);
    }
  }
}

export function closedAddress(
  projectId: string,
  filter: ClosedFilter,
  after: string | null,
): string {
  const query = new URLSearchParams({ closed: "1" });
  if (filter.q.trim() !== "") query.set("q", filter.q.trim());
  if (filter.state !== null) query.set("state", filter.state);
  if (after !== null) query.set("after", after);
  return `${listPath(projectId)}?${query}`;
}

// the closed tasks under the filter: the first page, then each after
// the cursor
async function readClosed(more: boolean): Promise<void> {
  const projectId = projectFor;
  if (projectId === null) return;
  const held = closedPages.value;
  if (more && (held === null || held.next === null)) return;
  const forUser = owner;
  const turn = ++closedTurn;
  const closed = closes;
  const labeled = relabels;
  const filter = closedFilter.value;
  closedMore.value = { loading: true, error: null };
  try {
    const body = await api<ClosedTasksResponse>(
      closedAddress(projectId, filter, more ? (held?.next ?? null) : null),
    );
    if (owner !== forUser || closedTurn !== turn) return;
    // a task reopened since it was asked is the unfinished list's
    const rows = body.tasks.filter(
      (t) => !gone.has(t.id) && latestOf(t.id) <= t.revision,
    );
    const now = closedPages.value;
    // a frame that landed while the page was out keeps its word; the
    // server's rows are the filter's, whatever the page would match
    const base = more
      ? rows.reduce(upsertClosed, now?.rows ?? [])
      : rows.reduce(
          readClosedRow,
          (now?.rows ?? []).filter((t) => rows.some((r) => r.id === t.id)),
        );
    closedPages.value = { rows: base, next: body.next };
    closedMore.value = idle;
    // a task closed while the first page was out is on neither list
    if (!more && (closes !== closed || relabels !== labeled)) {
      closedFlight.ask();
    }
  } catch (err) {
    if (owner === forUser && closedTurn === turn) {
      closedMore.value = { loading: false, error: failure(err) };
    }
  }
}

async function reloadClosed(): Promise<void> {
  if (closedPages.value !== null) await readClosed(false);
}

// the first closed page of the project the list was loaded for
export function loadClosedTasks(projectId: string): Promise<void> {
  if (projectFor !== projectId) return Promise.resolve();
  return closedFlight.run(() => readClosed(false));
}
export const loadMoreClosed = (): Promise<void> => readClosed(true);

// a new search or state: the pages read under the old one go, and an
// answer still out for it lands nowhere. The box's text is kept as
// typed, trailing space and all
export function filterClosed(filter: ClosedFilter): Promise<void> {
  const was = closedFilter.value;
  closedFilter.value = filter;
  if (sameClosed(filter, was)) return Promise.resolve();
  closedPages.value = null;
  closedMore.value = idle;
  return closedFlight.run(() => readClosed(false));
}

// a row from a frame or an answer into the lists; while none is held
// the read on its way places it
export function takeTask(row: ExternalTaskRow): void {
  if (gone.has(row.id)) return;
  if (latestOf(row.id) < row.revision) latest.set(row.id, row.revision);
  if (projectFor !== row.projectId) return;
  if (!unfinished(row.state)) closes++;
  const lists = listsHeld();
  if (lists === null) {
    listMoves++;
    return;
  }
  const next = applyTask(lists, row, closedFilter.value);
  if (next === lists) return;
  if (next.closed !== lists.closed) listMoves++;
  setLists(next);
}

// a deleted task out of the lists, once: a member's own delete is
// answered and then framed
export function forgetTask(id: string, projectId: string): void {
  if (gone.has(id)) return;
  gone.add(id);
  if (projectFor !== projectId) return;
  const lists = listsHeld();
  if (lists === null) {
    listMoves++;
    return;
  }
  const next = dropTask(lists, id);
  if (next.closed !== lists.closed) listMoves++;
  setLists(next);
}

export function onExternalTasksSocket(ev: SocketEvent): void {
  // a held list of a project off screen is loaded again when opened
  if (
    ev.type === "revoked" ||
    ((ev.type === "externalTask" ||
      ev.type === "externalTaskDeleted" ||
      ev.type === "projectLabels") &&
      ev.projectId !== projectFor)
  ) {
    kept.delete(ev.projectId);
  }
  switch (ev.type) {
    case "externalTask":
      takeTask(ev.task);
      break;
    case "externalTaskDeleted":
      forgetTask(ev.taskId, ev.projectId);
      break;
    // no row moved, so only a read shows the labels as they are now
    case "projectLabels":
      if (ev.projectId === projectFor) {
        relabels++;
        if (externalTasks.value !== null) listFlight.ask();
        if (closedPages.value !== null) closedFlight.ask();
      }
      break;
    case "revoked":
      if (ev.projectId === projectFor) {
        listTurn++;
        closedTurn++;
        listFlight.stop();
        closedFlight.stop();
        externalTasks.value = null;
        closedPages.value = null;
      }
      break;
    default:
      break;
  }
}

onSocketEvent(onExternalTasksSocket);
