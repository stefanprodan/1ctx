// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// External tasks: one project's unfinished list, loaded whole, with its
// closed pages read on unfold. A task's page and the writes are
// data/external-task.ts, Home's marked tasks data/marked-tasks.ts. The
// socket's frames keep the lists current by the revision rule; a frame
// the client cannot place asks for one trailing read. An answer is kept
// only for the user and the turn it was asked for.

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
  applyTask,
  type ClosedPages,
  dropTask,
  reconcile,
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
// how many are done or dropped
export const closedCount = signal(0);
// the closed pages read so far, null while folded
export const closedPages = signal<ClosedPages | null>(null);
export const closedMore = signal<{ loading: boolean; error: Failure | null }>({
  loading: false,
  error: null,
});
// the hours a claim goes without a report before it is released
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
    closedPages.value = null;
    closedMore.value = idle;
    closedTurn++;
    listFlight.stop();
    closedFlight.stop();
  }
  projectFor = projectId;
  externalTasksError.value = null;
  const moves = listMoves;
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

// the closed tasks unfolded: the first page, then each after the cursor
async function readClosed(more: boolean): Promise<void> {
  const projectId = projectFor;
  if (projectId === null) return;
  const held = closedPages.value;
  if (more && (held === null || held.next === null)) return;
  const forUser = owner;
  const turn = ++closedTurn;
  const closed = closes;
  closedMore.value = { loading: true, error: null };
  const query = new URLSearchParams({ closed: "1" });
  if (more && held?.next) query.set("after", held.next);
  try {
    const body = await api<ClosedTasksResponse>(
      `${listPath(projectId)}?${query}`,
    );
    if (owner !== forUser || closedTurn !== turn) return;
    // a task reopened since it was asked is the unfinished list's
    const rows = body.tasks.filter(
      (t) => !gone.has(t.id) && latestOf(t.id) <= t.revision,
    );
    const now = closedPages.value;
    // a frame that landed while the page was out keeps its word
    const base = more
      ? rows.reduce(upsertClosed, now?.rows ?? [])
      : rows.reduce(
          upsertClosed,
          (now?.rows ?? []).filter((t) => rows.some((r) => r.id === t.id)),
        );
    closedPages.value = { rows: base, next: body.next };
    closedMore.value = idle;
    // a task closed while the first page was out is on neither list
    if (!more && closes !== closed) closedFlight.ask();
  } catch (err) {
    if (owner === forUser && closedTurn === turn) {
      closedMore.value = { loading: false, error: failure(err) };
    }
  }
}

async function reloadClosed(): Promise<void> {
  if (closedPages.value !== null) await readClosed(false);
}

export const loadClosedTasks = (): Promise<void> =>
  closedFlight.run(() => readClosed(false));
export const loadMoreClosed = (): Promise<void> => readClosed(true);

// folded again: the pages go, read afresh on the next unfold
export function foldClosed(): void {
  closedTurn++;
  closedFlight.stop();
  closedPages.value = null;
  closedMore.value = idle;
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
  const next = applyTask(lists, row);
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
    ((ev.type === "externalTask" || ev.type === "externalTaskDeleted") &&
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
