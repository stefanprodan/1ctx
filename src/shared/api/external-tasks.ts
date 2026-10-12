// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the external task routes. Anyone who
// sees the project creates, edits, answers, unclaims, cancels, reopens
// and deletes; an agent claims and reports only over /mcp.

import type {
  ExternalTaskDetail,
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../contracts/external-task.ts";
import type { ExternalTaskState } from "../words.ts";

// GET /api/projects/:id/external-tasks: every unfinished task, blocked
// first, then claimed, then open, each by latest move; the count of
// closed ones; and the idle limit the page states
export type ExternalTasksResponse = {
  tasks: ExternalTaskRow[];
  closed: number;
  idleHours: number;
};

// GET /api/projects/:id/external-tasks?closed=1&q=&state=&after=: done
// and cancelled, or the one state named, holding q in the title, the scope
// or the creator's name, latest close first; next is the cursor of the
// page after under the same q and state
export type ClosedTasksResponse = {
  tasks: ExternalTaskRow[];
  next: string | null;
};

// GET /api/external-tasks?attention=1: the marked tasks across the
// user's projects, latest mark first, at most ATTENTION_ROWS; count is
// every marked one
export type AttentionTasksResponse = {
  tasks: ExternalTaskRow[];
  count: number;
  // the projects Home reads marks from, so a frame from another one,
  // which an admin also receives, stays off the card
  projectIds: string[];
};

// GET /api/external-tasks/:id?before=: the brief and a page of entries,
// newest first; next is the entry id to ask before, null at the first.
// A create (201), an edit and every move answer it too
export type ExternalTaskResponse = {
  task: ExternalTaskDetail;
  entries: ExternalTaskEntry[];
  next: string | null;
  idleHours: number;
};

// POST /api/projects/:id/external-tasks
export type CreateExternalTaskRequest = {
  title: string;
  text: string;
  scope?: string | null;
  // knowledge files of the project, in order
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

// POST /api/external-tasks/:id/seen names the mark the page read.
// A different or already cleared mark answers the unchanged detail.
export type ExternalTaskSeenRequest = { attentionAt: number };
