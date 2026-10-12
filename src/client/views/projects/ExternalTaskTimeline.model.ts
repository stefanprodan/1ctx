// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How the timeline reads its entries: each kind's icon, the question an
// answer follows, and the one question still waiting for a member.

import type {
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../../shared/contracts/external-task.ts";
import type { ClaimEnd, EntryKind } from "../../../shared/words.ts";
import type { IconName } from "../../lib/icons.tsx";
import { ENTRY_WORDS } from "./ExternalTasks.model.ts";

// a state's icon only where the entry is that move: a claim, a result
// and a drop; no colour, since green and the rest mean a task's state
export const ENTRY_ICONS: Record<EntryKind, IconName> = {
  claim: "play",
  progress: "progress",
  question: "question",
  result: "check",
  unclaim: "sign-out",
  answer: "chat",
  drop: "close",
  reopen: "redo",
};

// 1ctx's unclaim names why after a comma; a member's or agent's says it
// in its text
const SWEEP_REASONS: Partial<Record<ClaimEnd, string>> = {
  idle: "idle",
  access_gone: "access gone",
};

export function entryWords(
  entry: Pick<ExternalTaskEntry, "kind" | "claimEnd">,
): string {
  const reason =
    entry.kind === "unclaim" && entry.claimEnd !== null
      ? SWEEP_REASONS[entry.claimEnd]
      : undefined;
  const word = ENTRY_WORDS[entry.kind];
  return reason === undefined ? word : `${word}, ${reason}`;
}

export type TimelineLine = {
  entry: ExternalTaskEntry;
  // an answer's question on one line, when it is among those read
  question: string | null;
  // a question no answer followed, while its claim holds the task
  waiting: boolean;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// entries come newest first; an answer follows the latest question of
// its claim, and a claim or the end of one starts afresh
export function timelineOf(
  entries: readonly ExternalTaskEntry[],
  task: Pick<ExternalTaskRow, "claim">,
): TimelineLine[] {
  const lines = entries.map((entry) => ({
    entry,
    question: null as string | null,
    waiting: false,
  }));
  let asked: TimelineLine | null = null;
  let answered = false;
  for (const line of lines.toReversed()) {
    const { kind, claimEnd } = line.entry;
    if (kind === "question") {
      asked = line;
      answered = false;
    } else if (kind === "answer" && asked !== null) {
      line.question = oneLine(asked.entry.text);
      answered = true;
    } else if (kind === "claim" || claimEnd !== null) {
      asked = null;
    }
  }
  if (
    asked !== null &&
    !answered &&
    task.claim !== null &&
    asked.entry.claimId === task.claim.id
  ) {
    asked.waiting = true;
  }
  return lines;
}
