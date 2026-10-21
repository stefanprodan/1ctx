// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the external task routes. Anyone who
// sees the project creates, edits, answers, unclaims, cancels, reopens
// and deletes; an agent claims, reports, and makes, edits and cancels
// its own tasks only over /mcp.

import type {
  ExternalTaskDetail,
  ExternalTaskPageEntry,
  ExternalTaskRow,
} from "../contracts/external-task.ts";
import type { ExternalTaskState } from "../words.ts";

// GET /api/projects/:id/external-tasks: every unfinished task, awaiting
// input first, then in progress, then todo, each by latest move; the
// count of closed ones; and the idle limit the page states
export type ExternalTasksResponse = {
  tasks: ExternalTaskRow[];
  closed: number;
  idleHours: number;
};

// GET /api/projects/:id/external-tasks?closed=1&q=&state=&after=: done
// and canceled, or the one state named, holding q in the title, a label
// or the creator's name, latest close first; next is the cursor of the
// page after under the same q and state
export type ClosedTasksResponse = {
  tasks: ExternalTaskRow[];
  next: string | null;
};

// GET /api/external-tasks?waiting=1: the tasks awaiting input across
// the user's Home projects, the oldest question first, at most
// ATTENTION_ROWS; count is every one awaiting input
export type WaitingTasksResponse = {
  tasks: ExternalTaskRow[];
  count: number;
  // the projects Home reads from, so a frame from another one, which an
  // admin also receives, stays off the card
  projectIds: string[];
};

// GET /api/external-tasks/:id?before=: the brief and a page of entries,
// newest first; next is the entry id to ask before, null at the first.
// A create (201), an edit and every move answer it too
export type ExternalTaskResponse = {
  task: ExternalTaskDetail;
  entries: ExternalTaskPageEntry[];
  next: string | null;
  idleHours: number;
};

// POST /api/projects/:id/external-tasks
export type CreateExternalTaskRequest = {
  title: string;
  // 1 to MAX_TASK_LABELS of the project's label names
  labels: string[];
  // 1 to MAX_TASK_FILES knowledge files of the project, in order
  fileIds: string[];
};

// PATCH /api/external-tasks/:id: any of them, and the edit revision the
// form started from; a 409 once the brief moved on, and on a closed task
export type PatchExternalTaskRequest = Partial<CreateExternalTaskRequest> & {
  editRevision: number;
};

// POST /api/external-tasks/:id/answer|unclaim|cancel|reopen: the state
// the page shows, a 409 once the task moved on; unclaim also names the
// claim the page shows. Text is required for answer, unclaim and
// reopen, optional for cancel.
// DELETE /api/external-tasks/:id answers 204
export type ExternalTaskMoveRequest = {
  state: ExternalTaskState;
  text?: string;
  claimId?: string;
};
