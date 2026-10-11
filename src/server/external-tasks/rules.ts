// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  CLOSING_ENTRIES,
  MAX_BRIEF_BYTES,
  MAX_CLAIMS,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
  MAX_PART,
  MAX_TASK_FILES,
  MAX_UNFINISHED,
} from "../../shared/contracts/external-task.ts";
import {
  type EntryKind,
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
  MAX_BRIEF_BYTES,
  MAX_CLAIMS,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
  MAX_PART,
  MAX_TASK_FILES,
  MAX_UNFINISHED,
} from "../../shared/contracts/external-task.ts";

export type Actor = "agent" | "member" | "idle" | "access_gone";
export type Move = EntryKind | "claim";
export type Brief = {
  title: string;
  text: string;
  part: string | null;
  fileIds: string[];
};

const TRANSITIONS: Record<
  Actor,
  Partial<Record<Move, Partial<Record<ExternalTaskState, ExternalTaskState>>>>
> = {
  agent: {
    claim: { open: "claimed" },
    progress: { claimed: "claimed", blocked: "claimed" },
    question: { claimed: "blocked" },
    result: { claimed: "done", blocked: "done" },
    release: { claimed: "open", blocked: "open" },
  },
  member: {
    answer: { blocked: "claimed", claimed: "claimed" },
    release: { claimed: "open", blocked: "open" },
    drop: { open: "dropped", claimed: "dropped", blocked: "dropped" },
    reopen: { done: "open", dropped: "open" },
  },
  idle: { release: { claimed: "open" } },
  access_gone: { release: { claimed: "open", blocked: "open" } },
};

export function transition(
  state: ExternalTaskState,
  move: Move,
  actor: Actor,
): ExternalTaskState | null {
  return TRANSITIONS[actor][move]?.[state] ?? null;
}

export const closed = (state: ExternalTaskState) =>
  state === "done" || state === "dropped";

export function checkMove(
  state: ExternalTaskState,
  move: Move,
  actor: Actor,
): ExternalTaskState {
  const next = transition(state, move, actor);
  if (next === null) throw new Conflict(`this task is ${state}`);
  return next;
}

export function checkRoom(entries: number, move: Move): void {
  if (
    entries >= MAX_ENTRIES ||
    (entries >= CLOSING_ENTRIES &&
      move !== "result" &&
      move !== "release" &&
      move !== "drop")
  ) {
    throw new Conflict("make a new external task");
  }
}

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
  if (brief.part !== null && [...brief.part].length > MAX_PART) {
    throw new BadRequest(`part must be at most ${MAX_PART} characters`);
  }
  if (Buffer.byteLength(brief.text) > MAX_BRIEF_BYTES) {
    throw new BadRequest(`brief must be at most ${MAX_BRIEF_BYTES} bytes`);
  }
  if (
    brief.fileIds.length > MAX_TASK_FILES ||
    new Set(brief.fileIds).size !== brief.fileIds.length ||
    brief.fileIds.some((id) => id === "")
  ) {
    throw new BadRequest(`choose at most ${MAX_TASK_FILES} distinct files`);
  }
}

export function checkEntry(
  kind: EntryKind,
  text: string,
  links: string[],
): void {
  if (kind !== "drop" && text.trim() === "") {
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
