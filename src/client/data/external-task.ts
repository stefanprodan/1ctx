// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One external task's page: its brief and its entries, newest first, a
// page at a time; and every write on a task. A write keeps the server's
// row in the lists (data/external-tasks.ts) and on the page. A frame
// that adds an entry or edits the brief reads the page again, as does
// an answer older than a frame seen while it was out. A mark is cleared
// once the page is read, never by the read itself.

import { effect, signal } from "@preact/signals";
import type {
  CreateExternalTaskRequest,
  ExternalTaskMoveRequest,
  ExternalTaskResponse,
  PatchExternalTaskRequest,
} from "../../shared/api/external-tasks.ts";
import type {
  ExternalTaskDetail,
  ExternalTaskEntry,
  MemberMove,
} from "../../shared/contracts/external-task.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { forgetTask, isGone, latestOf, takeTask } from "./external-tasks.ts";
import { appendEntries, mergeEntries } from "./external-tasks-rows.ts";
import { Flight } from "./flight.ts";
import { Held } from "./held.ts";
import { loadKnowledge } from "./knowledge.ts";
import { me } from "./me.ts";
import { loadProject } from "./projects.ts";
import { onSocketEvent } from "./socket.ts";

// a task's page: its brief and the entries read so far, newest first
export type TaskPage = {
  id: string;
  detail: ExternalTaskDetail;
  entries: ExternalTaskEntry[];
  next: string | null;
  idleHours: number;
  more: { loading: boolean; error: Failure | null };
  // the revision the brief and the entries were read at; frames move
  // the row past it until the next read
  read: number;
};
export const taskPage = signal<TaskPage | null>(null);
export const taskError = signal<Failure | string | null>(null);

export const TASK_DELETED = "This external task was deleted.";
const NOT_SEEN = "You no longer see this project.";

let owner: string | null = null;
const pages = new Held<TaskPage>();
let pageTurn = 0;
// a later page of entries in flight belongs to the chain it was asked on
let moreTurn = 0;
// projects the user stopped seeing, by the turn of the revoke: a read
// started before it is dropped. A read started after it that answers
// clears it, since a grant made while the socket was down sends no frame
let revokes = 0;
const revokedAt = new Map<string, number>();
const idle = { loading: false, error: null };
// the read is hoisted, so the flight exists before the user effect runs
const pageFlight = new Flight(refreshPage);

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  pages.clear();
  revokedAt.clear();
  pageTurn++;
  moreTurn++;
  pageFlight.stop();
  taskPage.value = null;
  taskError.value = null;
});

const listPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/external-tasks`;
const taskPath = (id: string) =>
  `/api/external-tasks/${encodeURIComponent(id)}`;

// a task's answer onto its page. The brief and the entries are taken
// unless the page read them at a later revision; the row is the newer
// of the answer's and a frame's. An answer older than a frame seen
// while it was out asks for one more read, so an entry a frame counted
// is always read. A chain of entries that starts over drops the later
// page in flight.
// whether an answer to a read started at that turn still holds: a
// revoke after its start drops it, and an answer after one clears it
function holds(projectId: string, started: number): boolean {
  const at = revokedAt.get(projectId);
  if (at === undefined) return true;
  if (at > started) return false;
  revokedAt.delete(projectId);
  return true;
}

function takePage(body: ExternalTaskResponse, started: number): void {
  const row = body.task.task;
  if (!holds(row.projectId, started)) return;
  const held = taskPage.value?.id === row.id ? taskPage.value : null;
  if (held !== null && held.read > row.revision) return;
  const entries =
    held === null
      ? { entries: body.entries, next: body.next }
      : mergeEntries(held, body);
  const reset = held === null || entries.next !== held.next;
  if (reset) moreTurn++;
  const task =
    held !== null && held.detail.task.revision > row.revision
      ? held.detail.task
      : row;
  const next: TaskPage = {
    id: row.id,
    detail: { ...body.task, task },
    ...entries,
    idleHours: body.idleHours,
    more: reset ? idle : (held?.more ?? idle),
    read: row.revision,
  };
  taskPage.value = next;
  pages.set(row.id, next);
  if (latestOf(row.id) > row.revision) pageFlight.ask();
}

// the page's task read again; frames in a burst share one read
async function refreshPage(): Promise<void> {
  const id = taskPage.value?.id;
  if (id === undefined) return;
  const forUser = owner;
  const turn = pageTurn;
  const started = revokes;
  try {
    const body = await api<ExternalTaskResponse>(taskPath(id));
    if (owner === forUser && pageTurn === turn && taskPage.value?.id === id) {
      takePage(body, started);
    }
  } catch {
    // the next frame or load reads it again
  }
}

// the task's page: its row says which project it is in, whose name the
// crumb shows and whose files an edit picks from
export async function loadExternalTask(id: string): Promise<void> {
  const forUser = owner;
  const turn = ++pageTurn;
  const started = revokes;
  pageFlight.stop();
  taskError.value = null;
  if (taskPage.value?.id !== id) taskPage.value = pages.get(id) ?? null;
  let body: ExternalTaskResponse;
  try {
    body = await api<ExternalTaskResponse>(taskPath(id));
  } catch (err) {
    if (owner === forUser && pageTurn === turn) {
      pages.delete(id);
      taskPage.value = null;
      taskError.value = failure(err);
    }
    return;
  }
  if (owner !== forUser || pageTurn !== turn) return;
  if (!holds(body.task.task.projectId, started)) {
    taskPage.value = null;
    taskError.value = NOT_SEEN;
    return;
  }
  if (isGone(id)) {
    taskPage.value = null;
    taskError.value = TASK_DELETED;
    return;
  }
  takePage(body, started);
  takeTask(body.task.task);
  const projectId = body.task.task.projectId;
  const mark = body.task.task.attentionAt;
  if (mark !== null) void markSeen(id, mark).catch(() => {});
  await Promise.all([loadProject(projectId), loadKnowledge(projectId)]);
}

export async function loadMoreEntries(): Promise<void> {
  const held = taskPage.value;
  if (held === null || held.next === null || held.more.loading) return;
  const forUser = owner;
  const turn = pageTurn;
  const chain = ++moreTurn;
  const id = held.id;
  const cursor = held.next;
  const current = () =>
    owner === forUser &&
    pageTurn === turn &&
    moreTurn === chain &&
    taskPage.value?.id === id &&
    taskPage.value.next === cursor;
  taskPage.value = { ...held, more: { loading: true, error: null } };
  try {
    const body = await api<ExternalTaskResponse>(
      `${taskPath(id)}?before=${encodeURIComponent(cursor)}`,
    );
    const now = taskPage.value;
    if (!current() || now === null) return;
    taskPage.value = {
      ...now,
      entries: appendEntries(now.entries, body.entries),
      next: body.next,
      more: idle,
    };
    pages.set(id, taskPage.value);
  } catch (err) {
    const now = taskPage.value;
    if (current() && now !== null) {
      taskPage.value = {
        ...now,
        more: { loading: false, error: failure(err) },
      };
    }
  }
}

function takeAnswer(
  body: ExternalTaskResponse,
  forUser: string | null,
  started: number,
): void {
  if (owner !== forUser) return;
  if (!holds(body.task.task.projectId, started)) return;
  takeTask(body.task.task);
  if (taskPage.value?.id === body.task.task.id) takePage(body, started);
}

export async function createExternalTask(
  projectId: string,
  request: CreateExternalTaskRequest,
): Promise<ExternalTaskResponse> {
  const forUser = owner;
  const started = revokes;
  const body = await api<ExternalTaskResponse>(
    listPath(projectId),
    "POST",
    request,
  );
  takeAnswer(body, forUser, started);
  return body;
}

// an edit names the edit revision its form opened on
export async function editExternalTask(
  id: string,
  request: PatchExternalTaskRequest,
): Promise<ExternalTaskResponse> {
  const forUser = owner;
  const started = revokes;
  const body = await api<ExternalTaskResponse>(taskPath(id), "PATCH", request);
  takeAnswer(body, forUser, started);
  return body;
}

// a member's move names the state the page shows, and a release the
// claim it shows
export async function moveExternalTask(
  id: string,
  move: Exclude<MemberMove, "seen">,
  request: ExternalTaskMoveRequest,
): Promise<ExternalTaskResponse> {
  const forUser = owner;
  const started = revokes;
  const body = await api<ExternalTaskResponse>(
    `${taskPath(id)}/${move}`,
    "POST",
    request,
  );
  takeAnswer(body, forUser, started);
  return body;
}

// the mark the page read: one set since is left for the next look
export async function markSeen(id: string, attentionAt: number): Promise<void> {
  const forUser = owner;
  const started = revokes;
  const body = await api<Partial<ExternalTaskResponse>>(
    `${taskPath(id)}/seen`,
    "POST",
    { attentionAt },
  );
  if (body.task !== undefined) {
    takeAnswer(body as ExternalTaskResponse, forUser, started);
  }
}

export async function deleteExternalTask(id: string): Promise<void> {
  const forUser = owner;
  const projectId = taskPage.value?.detail.task.projectId ?? "";
  await api(taskPath(id), "DELETE");
  if (owner !== forUser) return;
  pages.delete(id);
  forgetTask(id, projectId);
}

function closePage(words: string): void {
  pageTurn++;
  pageFlight.stop();
  taskPage.value = null;
  taskError.value = words;
}

// registered after the lists' handler, which it imports, so a frame's
// revision is already the latest seen when the page reads it
export function onExternalTaskSocket(ev: SocketEvent): void {
  const page = taskPage.value;
  switch (ev.type) {
    case "externalTask": {
      if (
        page === null ||
        page.id !== ev.task.id ||
        ev.task.revision <= page.detail.task.revision
      ) {
        break;
      }
      const was = page.detail.task;
      taskPage.value = { ...page, detail: { ...page.detail, task: ev.task } };
      // the brief or the entries moved: the page reads them
      if (
        ev.task.entries !== was.entries ||
        ev.task.editRevision !== was.editRevision
      ) {
        pageFlight.ask();
      }
      break;
    }
    case "externalTaskDeleted":
      pages.delete(ev.taskId);
      if (page?.id === ev.taskId) closePage(TASK_DELETED);
      break;
    case "revoked":
      revokedAt.set(ev.projectId, ++revokes);
      pages.update((held) =>
        held.detail.task.projectId === ev.projectId ? null : held,
      );
      if (page?.detail.task.projectId === ev.projectId) closePage(NOT_SEEN);
      break;
    case "granted":
      revokedAt.delete(ev.projectId);
      break;
    default:
      break;
  }
}

onSocketEvent(onExternalTaskSocket);
