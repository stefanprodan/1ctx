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
  type ExternalTaskDetail,
  type ExternalTaskEntry,
  type ExternalTaskFile,
  type ExternalTaskRow,
  MAX_TASK_FILES,
  MAX_TASK_LABELS,
} from "../../../shared/contracts/external-task.ts";
import {
  type ClaimEnd,
  type ExternalTaskState,
  hasLineBreak,
  MAX_TITLE,
} from "../../../shared/words.ts";
import { clock, longDate } from "../../lib/format.ts";
import { externalTasksHref, type TasksShow } from "../../lib/hrefs.ts";
import { plainLine } from "../../lib/plain.ts";

export const INTRO = "Work for an agent you run outside 1ctx.";
export const UNCLAIMED = "Ask your agent to claim this task.";

export const GONE_USER = "a deleted user";

type Who = Pick<ExternalTaskEntry, "kind" | "by" | "keyName" | "claimEnd">;

// 1ctx's release says why in a word; its text says it whole
const SWEEP_REASONS: Partial<Record<ClaimEnd, string>> = {
  idle: "idle",
  access_gone: "access gone",
};

// the reason of an unclaim 1ctx made, null for any other entry
export function sweepReason(
  entry: Pick<ExternalTaskEntry, "kind" | "claimEnd">,
): string | null {
  if (entry.kind !== "unclaim" || entry.claimEnd === null) return null;
  return SWEEP_REASONS[entry.claimEnd] ?? null;
}

// who wrote an entry: an agent through a key, a member, or 1ctx on its
// own releases; with no user otherwise, the user was deleted, and a key
// outlives them
export function entryBy(entry: Who): string {
  const who =
    entry.by !== null
      ? `@${entry.by.username}`
      : sweepReason(entry) !== null
        ? "1ctx"
        : GONE_USER;
  return entry.keyName === null ? who : `${who} via ${entry.keyName}`;
}

// who opened a task; a deleted creator is named as one
export const openerOf = (row: Pick<ExternalTaskRow, "createdBy">): string =>
  row.createdBy === null ? GONE_USER : `@${row.createdBy.username}`;

// a row's second line, who moved it last: the question a task awaits,
// who holds it, who opened, gave back or reopened it, who closed it
export function rowLine(
  row: Pick<ExternalTaskRow, "state" | "claim" | "last" | "createdBy">,
): string {
  const last = row.last;
  switch (row.state) {
    case "awaiting_input":
      if (last?.kind === "question") return plainLine(last.text);
      break;
    case "done":
      if (last?.kind === "result") return `Done by ${entryBy(last)}`;
      return "Done";
    case "canceled":
      if (last?.kind === "cancel") return `Canceled by ${entryBy(last)}`;
      return "Canceled";
    case "todo":
      if (last?.kind === "reopen") return `Reopened by ${entryBy(last)}`;
      if (last?.kind === "unclaim") {
        const reason = sweepReason(last);
        return `Unclaimed by ${entryBy(last)}${reason === null ? "" : `, ${reason}`}`;
      }
      return `Opened by ${openerOf(row)}`;
    default:
      break;
  }
  return row.claim === null
    ? ""
    : `Claimed by @${row.claim.username} via ${row.claim.keyName}`;
}

// the line under a task's title: when it last moved, never who
export function movedWords(
  row: Pick<ExternalTaskRow, "state" | "last">,
): string {
  switch (row.state) {
    case "awaiting_input":
      return "Asked";
    case "in_progress":
      return "Updated";
    case "done":
      return "Done";
    case "canceled":
      return "Canceled";
    default:
      return row.last?.kind === "reopen"
        ? "Reopened"
        : row.last?.kind === "unclaim"
          ? "Unclaimed"
          : "Opened";
  }
}

// the tab's view and search as the address carries them: ?show=done or
// ?show=canceled, else Open, and ?q=
export function tasksAddressOf(search: string): {
  show: TasksShow | null;
  q: string;
} {
  const params = new URLSearchParams(search);
  const show = params.get("show");
  return {
    show: show === "done" || show === "canceled" ? show : null,
    q: params.get("q")?.trim() ?? "",
  };
}

// the view a task in this state is listed on, null for Open
export const showOf = (state: ExternalTaskState): TasksShow | null =>
  state === "done" || state === "canceled" ? state : null;

const VIEWS: { show: TasksShow | null; label: string }[] = [
  { show: null, label: "Open" },
  { show: "done", label: "Done" },
  { show: "canceled", label: "Canceled" },
];

// the switch: each view's address, keeping the search
export function tasksSwitch(
  projectId: string,
  show: TasksShow | null,
  q: string,
): { label: string; on: boolean; href: string }[] {
  return VIEWS.map((view) => ({
    label: view.label,
    on: view.show === show,
    href: externalTasksHref(projectId, view.show, q),
  }));
}

// the tab's groups, in the order of whose turn it is
export const GROUPS = [
  { state: "awaiting_input", label: "Awaiting input" },
  { state: "in_progress", label: "In progress" },
  { state: "todo", label: "Todo" },
] as const satisfies readonly { state: ExternalTaskState; label: string }[];

export type GroupState = (typeof GROUPS)[number]["state"];

// a group shows this many rows, then Show more adds as many again
export const GROUP_ROWS = 20;

export type TaskGroup = {
  state: GroupState;
  label: string;
  rows: ExternalTaskRow[];
  total: number;
  more: boolean;
};

// the unfinished rows as the tab draws them: each state that has a row,
// cut to what its Show more has opened
export function groupsOf(
  rows: readonly ExternalTaskRow[],
  shown: Partial<Record<GroupState, number>>,
): TaskGroup[] {
  return GROUPS.flatMap(({ state, label }) => {
    const all = rows.filter((row) => row.state === state);
    if (all.length === 0) return [];
    const limit = shown[state] ?? GROUP_ROWS;
    return [
      {
        state,
        label,
        rows: all.slice(0, limit),
        total: all.length,
        more: all.length > limit,
      },
    ];
  });
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

// when the idle sweep unclaims this claim, from its last report on the
// sweep's own basis; a task awaiting input waits for a member and never
// idles
export function claimDeadline(
  task: Pick<ExternalTaskRow, "state" | "claim">,
  idleHours: number,
): number | null {
  if (task.state !== "in_progress" || task.claim === null) return null;
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
// canceled until it closes, a held task unclaimed, an answer given while
// it awaits input, a closed task reopened; delete always
export function movesOf(state: ExternalTaskState) {
  const held = state === "in_progress" || state === "awaiting_input";
  const open = held || state === "todo";
  return {
    edit: open,
    answer: state === "awaiting_input",
    unclaim: held,
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
    going: "Canceling",
    required: false,
  },
  reopen: {
    label: "Reopen",
    going: "Reopening",
    required: true,
  },
};

// the brief's form
export const NO_LABEL = "Pick at least one label.";

export type Draft = {
  title: string;
  labels: string[];
  fileIds: string[];
};

export function draftOf(detail: ExternalTaskDetail | null): Draft {
  if (detail === null) return { title: "", labels: [], fileIds: [] };
  return {
    title: detail.task.title,
    labels: detail.task.labels,
    fileIds: detail.files.map((f) => f.fileId),
  };
}

type LabelRef = { id: string; name: string };

// the ids a task's label names stand for among the project's labels as
// the form opened; a name the project no longer has is left out
export function labelIdsOf(
  names: readonly string[],
  labels: readonly LabelRef[],
): string[] {
  return names.flatMap((name) => {
    const label = labels.find((l) => l.name === name);
    return label === undefined ? [] : [label.id];
  });
}

// the picked labels by their names now: a label renamed since it was
// picked takes its new name, a deleted one goes
export function labelNamesOf(
  ids: readonly string[],
  labels: readonly LabelRef[],
): string[] {
  return ids.flatMap((id) => {
    const label = labels.find((l) => l.id === id);
    return label === undefined ? [] : [label.name];
  });
}

// a label picked joins the others, once and at most MAX_TASK_LABELS;
// a pick deleted from the project since leaves first, so it never
// holds a place the form shows as free
export function pickLabel(
  ids: readonly string[],
  id: string,
  labels: readonly LabelRef[],
): string[] {
  const live = ids.filter((l) => labels.some((label) => label.id === l));
  if (!labels.some((label) => label.id === id)) return live;
  if (live.includes(id) || live.length >= MAX_TASK_LABELS) return live;
  return [...live, id];
}

// a file made in the form joins its links, once and within the bound
export function withFile(draft: Draft, fileId: string): Draft {
  if (draft.fileIds.includes(fileId)) return draft;
  if (draft.fileIds.length >= MAX_TASK_FILES) return draft;
  return { ...draft, fileIds: [...draft.fileIds, fileId] };
}

// the links are in order, so an order changed is a change
const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

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
  if (draft.labels.length === 0) return { problem: NO_LABEL, field: "labels" };
  if (draft.labels.length > MAX_TASK_LABELS) {
    return {
      problem: `labels: pick 1 to ${MAX_TASK_LABELS}`,
      field: "labels",
    };
  }
  if (draft.fileIds.length === 0 || draft.fileIds.length > MAX_TASK_FILES) {
    return { problem: `link 1 to ${MAX_TASK_FILES} files`, field: "files" };
  }
  return {
    body: { title, labels: draft.labels, fileIds: draft.fileIds },
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
    ...(sameOrder(body.labels, was.labels) ? {} : { labels: body.labels }),
    ...(sameOrder(body.fileIds, was.fileIds) ? {} : { fileIds: body.fileIds }),
  };
}

export function dirtyOf(draft: Draft, detail: ExternalTaskDetail | null) {
  const was = draftOf(detail);
  return (
    draft.title !== was.title ||
    !sameOrder(draft.labels, was.labels) ||
    !sameOrder(draft.fileIds, was.fileIds)
  );
}

// a server refusal names its field by its first word
export function taskFieldOf(message: string): string | undefined {
  const word = message.trim().toLowerCase();
  if (word.startsWith("a title") || word.startsWith("title")) return "title";
  if (word.startsWith("labels")) return "labels";
  if (word.includes("file")) return "files";
  return undefined;
}
