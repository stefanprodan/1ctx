// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How the activity reads its entries: each kind's icon and verb, the
// question an answer follows, the one question still waiting for a
// member, which lines start open, and the question folding once it
// stops waiting.

import type {
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../../shared/contracts/external-task.ts";
import type { EntryKind } from "../../../shared/words.ts";
import type { IconName } from "../../lib/icons.tsx";
import { plainLine } from "../../lib/plain.ts";
import { sweepReason } from "./ExternalTasks.model.ts";

// a state's icon only where the entry is that move: a claim, a question,
// a result and a cancel; no colour, since green and the rest mean a
// task's state
export const ENTRY_ICONS: Record<EntryKind, IconName> = {
  claim: "play",
  progress: "progress",
  question: "question",
  result: "check",
  unclaim: "sign-out",
  answer: "chat",
  cancel: "cancelled",
  reopen: "redo",
  edit: "pencil",
};

// what each entry did, as the verb its line opens with
export const VERBS: Record<EntryKind, string> = {
  claim: "Claimed",
  progress: "Reported",
  question: "Asked",
  result: "Finished",
  unclaim: "Unclaimed",
  answer: "Answered",
  cancel: "Canceled",
  reopen: "Reopened",
  edit: "Edited",
};

// an agent's reports belong to the claim above them, so their lines
// name no one; every other move changes who holds the task and says who
export const REPORTS: ReadonlySet<EntryKind> = new Set([
  "progress",
  "question",
  "result",
]);

export type TimelineLine<E extends ExternalTaskEntry = ExternalTaskEntry> = {
  entry: E;
  // an answer's question on one line, when it is among those read
  question: string | null;
  // the question that blocks the task: once an answer or the agent's
  // own progress moves it on, nothing waits
  waiting: boolean;
};

// entries come newest first; an answer follows the latest question of
// its claim, and a claim or the end of one starts afresh
export function timelineOf<E extends ExternalTaskEntry>(
  entries: readonly E[],
  task: Pick<ExternalTaskRow, "claim" | "state">,
): TimelineLine<E>[] {
  const lines = entries.map((entry) => ({
    entry,
    question: null as string | null,
    waiting: false,
  }));
  let asked: TimelineLine<E> | null = null;
  let answered = false;
  for (const line of lines.toReversed()) {
    const { kind, claimEnd } = line.entry;
    if (kind === "question") {
      asked = line;
      answered = false;
    } else if (kind === "answer" && asked !== null) {
      line.question = plainLine(asked.entry.text);
      answered = true;
    } else if (kind === "claim" || claimEnd !== null) {
      asked = null;
    }
  }
  if (
    task.state === "awaiting_input" &&
    asked !== null &&
    !answered &&
    task.claim !== null &&
    asked.entry.claimId === task.claim.id
  ) {
    asked.waiting = true;
  }
  return lines;
}

export type ActivityLine<E extends ExternalTaskEntry = ExternalTaskEntry> =
  TimelineLine<E> & {
    // the line's words: 1ctx's reason, else the text's first line as a
    // reader sees it
    line: string;
    // opened under it at first: the waiting question, and on a task in
    // progress the latest report with words but an answered question
    open: boolean;
  };

// the entries read, oldest first, as the page's activity draws them
export function activityOf<E extends ExternalTaskEntry>(
  entries: readonly E[],
  task: Pick<ExternalTaskRow, "claim" | "state">,
): ActivityLine<E>[] {
  const lines = timelineOf(entries, task);
  const latest =
    task.state === "in_progress"
      ? lines.find((l) => REPORTS.has(l.entry.kind) && l.entry.text !== "")
      : undefined;
  return lines.toReversed().map((l) => ({
    ...l,
    line: sweepReason(l.entry) ?? plainLine(l.entry.text),
    open:
      l.entry.text !== "" &&
      (l.waiting || (l === latest && l.entry.kind !== "question")),
  }));
}

// a line's open state once its question's wait changes: the line the
// page opened as the waiting question folds when nothing waits on it,
// and what the reader opened by hand after stays
export function foldOf(
  open: boolean,
  waited: boolean,
  waiting: boolean,
): boolean {
  return waited && !waiting ? false : open;
}
