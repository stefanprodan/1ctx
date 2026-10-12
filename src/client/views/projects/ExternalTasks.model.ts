// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of external tasks, the moves each state offers, and the
// brief's form: its draft, its checks and what a create or an edit
// sends.

import type {
  CreateExternalTaskRequest,
  PatchExternalTaskRequest,
} from "../../../shared/api/external-tasks.ts";
import {
  type ExternalTaskClaim,
  type ExternalTaskDetail,
  type ExternalTaskEntry,
  type ExternalTaskFile,
  type ExternalTaskRow,
  MAX_BRIEF_BYTES,
  MAX_SCOPE,
  MAX_TASK_FILES,
} from "../../../shared/contracts/external-task.ts";
import {
  type EntryKind,
  type ExternalTaskState,
  hasLineBreak,
  MAX_TITLE,
} from "../../../shared/words.ts";
import { clock, longDate } from "../../lib/format.ts";
import type { IconName } from "../../lib/icons.tsx";

export const INTRO = "Work for an agent you run outside 1ctx.";
export const UNCLAIMED = "Ask your agent to claim this task.";

export const claimWords = (claim: ExternalTaskClaim): string =>
  `claimed by ${claim.username} via ${claim.keyName}`;

// the state as a row's sub and the brief's line say it
export function stateLine(
  row: Pick<ExternalTaskRow, "state" | "claim">,
): string {
  if (row.state === "claimed" && row.claim !== null) {
    return claimWords(row.claim);
  }
  if (row.state === "blocked" && row.claim !== null) {
    return `blocked · ${claimWords(row.claim)}`;
  }
  return row.state;
}

// a row's line: the icon and the section say open, done and cancelled
export const rowLine = (row: Pick<ExternalTaskRow, "state" | "claim">) =>
  row.state === "claimed" || row.state === "blocked" ? stateLine(row) : "";

export const ENTRY_WORDS: Record<EntryKind, string> = {
  claim: "Claimed",
  progress: "Progress",
  question: "Question",
  result: "Result",
  unclaim: "Unclaimed",
  answer: "Answer",
  cancel: "Cancelled",
  reopen: "Reopened",
};

export const GONE_USER = "a deleted user";

// who wrote an entry: an agent through a key, a member, or 1ctx itself;
// a key outlives its deleted user
export function entryBy(
  entry: Pick<ExternalTaskEntry, "by" | "keyName">,
): string {
  const who = entry.by === null ? null : `@${entry.by.username}`;
  if (entry.keyName !== null) return `${who ?? GONE_USER} via ${entry.keyName}`;
  return who ?? "1ctx";
}

// the row's second line: the latest entry, cut by the server; none
// before the first
export function lastLine(row: Pick<ExternalTaskRow, "last">): string | null {
  if (row.last === null) return null;
  const text = row.last.text.replace(/\s+/g, " ").trim();
  return text === ""
    ? ENTRY_WORDS[row.last.kind]
    : `${ENTRY_WORDS[row.last.kind]}: ${text}`;
}

// an entry's link is a link only when it is a web address
export function webLink(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// a linked file by its name; a deleted one keeps the name history had
export function fileLabel(file: Pick<ExternalTaskFile, "name" | "deleted">) {
  if (!file.deleted && file.name !== null) return file.name;
  return file.name === null ? "a deleted file" : `deleted: ${file.name}`;
}

// the icon and its colour: a mark wins, then the state's own; a closed
// task keeps its own, as its mark only lists a result to read
export function taskIcon(row: Pick<ExternalTaskRow, "state" | "attentionAt">): {
  name: IconName;
  status: "running" | "done" | "attention" | "stopped" | null;
} {
  const marked = row.attentionAt !== null ? "attention" : null;
  switch (row.state) {
    case "blocked":
      return { name: "question", status: "attention" };
    case "claimed":
      return { name: "play", status: marked ?? "running" };
    case "done":
      return { name: "check", status: "done" };
    case "cancelled":
      return { name: "cancelled", status: "stopped" };
    default:
      return { name: "task-open", status: marked };
  }
}

// when the idle sweep unclaims this claim, from its last report on the
// sweep's own basis; a blocked task waits for a member and never idles
export function claimDeadline(
  task: Pick<ExternalTaskRow, "state" | "claim">,
  idleHours: number,
): number | null {
  if (task.state !== "claimed" || task.claim === null) return null;
  return task.claim.activeAt + idleHours * 3_600_000;
}

// when the claim ends, as the aside says it: the time today, else the
// date as Created reads, then the time
export function deadlineTime(at: number, now: number): string {
  const today = new Date(at).toDateString() === new Date(now).toDateString();
  return today ? clock(at) : `${longDate(at)}, ${clock(at)}`;
}

// the chat a task was made in; an untitled one as Storage names it
// a title the server cut at MAX_TITLE ends on a whole word, never half
// of one; a shorter one ending in … was written so and stays
export function chatName(title: string): string {
  const text = title.trim();
  if (text === "") return "Untitled chat";
  // only a cut at the full MAX_TITLE can end mid word; a shorter one
  // trimmed a space or a split pair, a whole word either way
  if (!text.endsWith("…") || text.length < MAX_TITLE) return text;
  const kept = text.slice(0, -1);
  const space = kept.search(/\s\S*$/);
  return space <= 0 ? text : `${kept.slice(0, space).trimEnd()}…`;
}

// what the page offers in a state: the brief is edited and the task
// cancelled until it closes, a claimed task unclaimed while held, an answer
// given while blocked, a closed task reopened; delete always
export function movesOf(state: ExternalTaskState) {
  const open = state === "open" || state === "claimed" || state === "blocked";
  return {
    edit: open,
    answer: state === "blocked",
    unclaim: state === "claimed" || state === "blocked",
    cancel: open,
    reopen: !open,
  };
}

export type Move = "unclaim" | "cancel" | "reopen";

// each move's button and its box; cancel alone takes no reason
export const MOVE_WORDS: Record<
  Move,
  { label: string; going: string; required: boolean }
> = {
  unclaim: {
    label: "Unclaim",
    going: "Unclaiming",
    required: true,
  },
  cancel: {
    label: "Cancel task",
    going: "Cancelling",
    required: false,
  },
  reopen: {
    label: "Reopen",
    going: "Reopening",
    required: true,
  },
};

// the brief's form
export type Draft = {
  title: string;
  scope: string;
  text: string;
  fileIds: string[];
};

export function draftOf(detail: ExternalTaskDetail | null): Draft {
  if (detail === null) return { title: "", scope: "", text: "", fileIds: [] };
  return {
    title: detail.task.title,
    scope: detail.task.scope ?? "",
    text: detail.text,
    fileIds: detail.files.map((f) => f.fileId),
  };
}

// the links are in order, so an order changed is a change
const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

const bytes = (text: string) => new TextEncoder().encode(text).length;

// the checks the server makes too, so a refusal is at its field at once
export function requestOf(
  draft: Draft,
): { body: CreateExternalTaskRequest } | { problem: string; field: string } {
  const title = draft.title.trim();
  if (title === "") return { problem: "a title is required", field: "title" };
  if (hasLineBreak(title)) {
    return { problem: "a title is one line", field: "title" };
  }
  if (title.length > MAX_TITLE) {
    return {
      problem: `a title is at most ${MAX_TITLE} characters`,
      field: "title",
    };
  }
  const scope = draft.scope.trim();
  if (scope.length > MAX_SCOPE || hasLineBreak(scope)) {
    return {
      problem: `a scope is one line of at most ${MAX_SCOPE} characters`,
      field: "scope",
    };
  }
  if (draft.text.trim() === "") {
    return { problem: "the brief is required", field: "text" };
  }
  if (bytes(draft.text) > MAX_BRIEF_BYTES) {
    return {
      problem: `the brief is at most ${MAX_BRIEF_BYTES / 1024} KiB`,
      field: "text",
    };
  }
  if (draft.fileIds.length > MAX_TASK_FILES) {
    return { problem: `at most ${MAX_TASK_FILES} files`, field: "files" };
  }
  return {
    body: {
      title,
      text: draft.text,
      scope: scope === "" ? null : scope,
      fileIds: draft.fileIds,
    },
  };
}

// an edit sends only what changed, so a field nobody touched is never
// sent back, and the edit revision the form opened on
export function patchOf(
  body: CreateExternalTaskRequest,
  detail: ExternalTaskDetail,
  editRevision: number,
): PatchExternalTaskRequest {
  const was = draftOf(detail);
  return {
    editRevision,
    ...(body.title === was.title ? {} : { title: body.title }),
    ...((body.scope ?? "") === was.scope ? {} : { scope: body.scope ?? null }),
    ...(body.text === was.text ? {} : { text: body.text }),
    ...(sameOrder(body.fileIds, was.fileIds) ? {} : { fileIds: body.fileIds }),
  };
}

export function dirtyOf(draft: Draft, detail: ExternalTaskDetail | null) {
  const was = draftOf(detail);
  return (
    draft.title !== was.title ||
    draft.scope !== was.scope ||
    draft.text !== was.text ||
    !sameOrder(draft.fileIds, was.fileIds)
  );
}

// a server refusal names its field by its first word
export function taskFieldOf(message: string): string | undefined {
  const word = message.trim().toLowerCase();
  if (word.startsWith("a title") || word.startsWith("title")) return "title";
  if (word.startsWith("a scope") || word.startsWith("scope")) return "scope";
  if (word.startsWith("the brief") || word.startsWith("text")) return "text";
  if (word.includes("file")) return "files";
  return undefined;
}
