// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  CLOSING_ENTRIES,
  MAX_CLAIMS,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
  MAX_TASK_FILES,
  MAX_TASK_LABELS,
  MAX_UNFINISHED,
} from "../../shared/contracts/external-task.ts";
import { shapeLabelName } from "../../shared/contracts/label.ts";
import {
  type EntryKind,
  EXTERNAL_TASK_STATE_WORDS,
  type ExternalTaskState,
  hasLineBreak,
  MAX_TITLE,
} from "../../shared/words.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";

export {
  ATTENTION_ROWS,
  CLOSED_PAGE,
  CLOSING_ENTRIES,
  ENTRIES_PAGE,
  MAX_CLAIMS,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
  MAX_TASK_FILES,
  MAX_TASK_LABELS,
  MAX_UNFINISHED,
} from "../../shared/contracts/external-task.ts";

export type Actor = "agent" | "member" | "idle" | "access_gone";
export type Move = EntryKind;
// labels by name as given, shaped by checkBrief's caller
export type Brief = {
  title: string;
  labels: string[];
  fileIds: string[];
};

const TRANSITIONS: Record<
  Actor,
  Partial<Record<Move, Partial<Record<ExternalTaskState, ExternalTaskState>>>>
> = {
  agent: {
    claim: { todo: "in_progress" },
    progress: { in_progress: "in_progress", awaiting_input: "in_progress" },
    // a second question while one waits keeps the task waiting
    question: {
      in_progress: "awaiting_input",
      awaiting_input: "awaiting_input",
    },
    result: { in_progress: "done", awaiting_input: "done" },
    unclaim: { in_progress: "todo", awaiting_input: "todo" },
  },
  member: {
    answer: { awaiting_input: "in_progress", in_progress: "in_progress" },
    unclaim: { in_progress: "todo", awaiting_input: "todo" },
    cancel: {
      todo: "canceled",
      in_progress: "canceled",
      awaiting_input: "canceled",
    },
    reopen: { done: "todo", canceled: "todo" },
  },
  // a task awaiting input waits for a member, never idles
  idle: { unclaim: { in_progress: "todo" } },
  access_gone: { unclaim: { in_progress: "todo", awaiting_input: "todo" } },
};

export function transition(
  state: ExternalTaskState,
  move: Move,
  actor: Actor,
): ExternalTaskState | null {
  return TRANSITIONS[actor][move]?.[state] ?? null;
}

export const closed = (state: ExternalTaskState) =>
  state === "done" || state === "canceled";

// a refused move names the state as the page says it
export const isState = (state: ExternalTaskState) =>
  `this task is ${EXTERNAL_TASK_STATE_WORDS[state].toLowerCase()}`;

export function checkMove(
  state: ExternalTaskState,
  move: Move,
  actor: Actor,
): ExternalTaskState {
  const next = transition(state, move, actor);
  if (next === null) throw new Conflict(isState(state));
  return next;
}

export function checkRoom(entries: number, move: Move): void {
  if (
    entries >= MAX_ENTRIES ||
    (entries >= CLOSING_ENTRIES &&
      move !== "result" &&
      move !== "unclaim" &&
      move !== "cancel")
  ) {
    throw new Conflict("make a new external task");
  }
}

// claims since the task's last reopen
export function checkClaims(claims: number): void {
  if (claims >= MAX_CLAIMS) throw new Conflict("make a new external task");
}

export function checkUnfinished(count: number): void {
  if (count >= MAX_UNFINISHED)
    throw new Conflict("project has too many unfinished external tasks");
}

export function checkBrief(brief: Brief): void {
  if (
    brief.title.trim() === "" ||
    hasLineBreak(brief.title) ||
    [...brief.title].length > MAX_TITLE
  ) {
    throw new BadRequest(
      `title must be one line of 1 to ${MAX_TITLE} characters`,
    );
  }
  const labels = brief.labels.map(shapeLabelName);
  if (
    labels.length === 0 ||
    labels.length > MAX_TASK_LABELS ||
    new Set(labels).size !== labels.length ||
    labels.some((name) => name === "")
  ) {
    throw new BadRequest(
      `labels must name 1 to ${MAX_TASK_LABELS} distinct labels of the project`,
    );
  }
  if (
    brief.fileIds.length === 0 ||
    brief.fileIds.length > MAX_TASK_FILES ||
    new Set(brief.fileIds).size !== brief.fileIds.length ||
    brief.fileIds.some((id) => id === "")
  ) {
    throw new BadRequest(`choose 1 to ${MAX_TASK_FILES} distinct files`);
  }
}

export function checkEntry(
  kind: EntryKind,
  text: string,
  links: string[],
): void {
  if (kind !== "cancel" && text.trim() === "") {
    throw new BadRequest("entry text is required");
  }
  if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) {
    throw new BadRequest(`entry must be at most ${MAX_ENTRY_BYTES} bytes`);
  }
  if (links.length > MAX_ENTRY_LINKS) {
    throw new BadRequest(`choose at most ${MAX_ENTRY_LINKS} links`);
  }
  for (const link of links) {
    if (
      Buffer.byteLength(link) > MAX_LINK_BYTES ||
      !URL.canParse(link) ||
      !["http:", "https:"].includes(new URL(link).protocol)
    ) {
      throw new BadRequest(
        `links must be http(s) URLs of at most ${MAX_LINK_BYTES} bytes`,
      );
    }
  }
}

export function parseCursor(value: string): { at: number; id: string } {
  const match = /^(0|[1-9][0-9]*)\.([0-9a-z]{12})$/.exec(value);
  if (match === null || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequest("invalid cursor");
  }
  return { at: Number(match[1]), id: match[2]! };
}
