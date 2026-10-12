// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task as the wire exposes it: work a member hands to an
// agent that runs outside 1ctx, with linked knowledge files, claimed
// through a user's access key and reported on until it closes. The
// revision moves on every change to the row, and a client applies a
// frame only when its revision is above the one it holds. The edit
// revision moves only when the brief is edited; an edit names the one
// it started from, so an agent's reports never make it stale.

import type {
  AgentEntryKind,
  ClaimEnd,
  EntryKind,
  ExternalTaskState,
} from "../words.ts";

// the claim a task is held under, while it is claimed or blocked
export type ExternalTaskClaim = {
  id: string;
  keyId: string;
  userId: string;
  username: string;
  // the key's name, kept once the key is deleted
  keyName: string;
  startedAt: number;
  // the claim or its last report or answer; the idle sweep unclaims a
  // claimed task externalTaskIdleHours after it
  activeAt: number;
};

// a row of the project's list, Home's section and a frame
export type ExternalTaskRow = {
  id: string;
  projectId: string;
  title: string;
  scope: string | null;
  state: ExternalTaskState;
  revision: number;
  editRevision: number;
  claim: ExternalTaskClaim | null;
  // the latest entry, its text cut to MAX_LAST_LINE
  last: { kind: EntryKind; text: string; at: number } | null;
  entries: number;
  // since when it needs a member, null when it does not
  attentionAt: number | null;
  createdBy: { id: string; username: string } | null;
  createdAt: number;
  // the last state change, or creation; on a closed task it is the close
  movedAt: number;
};

// a linked knowledge file by id; a deleted one keeps its link and its
// name from history, or null once history is pruned
export type ExternalTaskFile = {
  fileId: string;
  name: string | null;
  // null when deleted
  revision: number | null;
  deleted: boolean;
};

export type ExternalTaskEntry = {
  id: string;
  kind: EntryKind;
  text: string;
  links: string[];
  // null when 1ctx wrote it
  by: { id: string; username: string } | null;
  // the key an agent's entry came through
  keyName: string | null;
  // the claim this entry belongs to or ends, including member/system ends
  claimId: string | null;
  // set on the entry that ended a claim
  claimEnd: ClaimEnd | null;
  at: number;
};

// the brief and its files; the entries page beside it
export type ExternalTaskDetail = {
  task: ExternalTaskRow;
  text: string;
  files: ExternalTaskFile[];
  // when the brief was last edited, the create at first
  briefAt: number;
  // the chat that made it, null otherwise or once deleted
  chatId: string | null;
  // its title, only when the reader may open that chat
  chatTitle: string | null;
};

// the moves a member makes on the page; `seen` clears the mark
export const MEMBER_MOVES = [
  "answer",
  "unclaim",
  "cancel",
  "reopen",
  "seen",
] as const;
export type MemberMove = (typeof MEMBER_MOVES)[number];

export type { AgentEntryKind };

// bounds (decision 27): the brief and an entry fit show's 32 KiB page
export const MAX_TASK_FILES = 10;
export const MAX_SCOPE = 80;
export const MAX_BRIEF_BYTES = 16 * 1024;
export const MAX_ENTRY_BYTES = 16 * 1024;
export const MAX_ENTRY_LINKS = 5;
export const MAX_LINK_BYTES = 2048;
export const MAX_ENTRIES = 250;
// from here a task takes only the moves that end a claim or close it
export const CLOSING_ENTRIES = 240;
export const MAX_CLAIMS = 20;
export const MAX_UNFINISHED = 500;
// Home's section; the count says how many more are marked
export const ATTENTION_ROWS = 50;
export const ENTRIES_PAGE = 50;
export const CLOSED_PAGE = 50;

// a move or an edit on a state, claim or edit revision the task has
// moved past; nothing is written
export const STALE_TASK = "changed since you opened it";
