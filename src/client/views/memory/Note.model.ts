// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the note card: the count against the limit, who wrote
// the note last, and the draft an edit works on with the refusal pinned
// to the entry it names, tested without a DOM.

import type { Memory, MemoryEntry } from "../../../shared/contracts/memory.ts";
import {
  checkEntries,
  MEMORY_ENTRY_CHARS,
  memorySize,
  normalize,
} from "../../../shared/memory.ts";
import { ago } from "../../lib/format.ts";

export type Writer =
  | { kind: "none" }
  | { kind: "user"; username: string; when: string }
  | {
      kind: "run";
      sessionId: string;
      automationId: string | null;
      automationName: string | null;
      when: string;
    };

// who last wrote the note, for the head
export function writerOf(memory: Memory, now: number): Writer {
  if (memory.updatedAt === null) return { kind: "none" };
  const when = ago(memory.updatedAt, now);
  if (memory.updatedBy !== null) {
    return { kind: "user", username: memory.updatedBy.username, when };
  }
  if (memory.run !== null) return { kind: "run", ...memory.run, when };
  return { kind: "none" };
}

export function countLine(entries: readonly MemoryEntry[]): string {
  return `${memorySize(entries)} characters`;
}

// the size under a text box, the same numbers a refusal gives
export function textSize(text: string): string {
  return `${text.trim().length}/${MEMORY_ENTRY_CHARS}`;
}

// an entry with neither a topic nor a text is a box left blank, not an
// entry
const blank = (entry: MemoryEntry) =>
  entry.topic.trim() === "" && entry.text.trim() === "";

// the entries a save sends: cleaned, blank boxes dropped
export function draftEntries(draft: readonly MemoryEntry[]): MemoryEntry[] {
  return normalize(draft.filter((entry) => !blank(entry)));
}

// The form saves a topic whose case changed, so it compares exactly,
// unlike the diff, where the case of a topic is the same topic.
export function draftDirty(
  draft: readonly MemoryEntry[],
  entries: readonly MemoryEntry[],
): boolean {
  const next = draftEntries(draft);
  return (
    next.length !== entries.length ||
    next.some(
      (entry, index) =>
        entry.topic !== entries[index]!.topic ||
        entry.text !== entries[index]!.text,
    )
  );
}

// the control of an entry's field, by the box's place in the draft
export const topicField = (index: number) => `topic-${index + 1}`;
export const textField = (index: number) => `text-${index + 1}`;

// The first refusal of the draft at the box it names: the shared check
// run on each longer prefix, so the entry that first fails is the one to
// fix, and a note past the budget points at the entry that passed it.
export function draftProblem(
  draft: readonly MemoryEntry[],
): { error: string; field: string } | null {
  const kept: MemoryEntry[] = [];
  for (const [index, entry] of draft.entries()) {
    if (blank(entry)) continue;
    kept.push(...normalize([entry]));
    const error = checkEntries(kept);
    if (error === null) continue;
    const field = error.startsWith("The topic")
      ? topicField(index)
      : textField(index);
    return { error, field };
  }
  return null;
}

// which box a server refusal of a save names, by the topic or the place
// its words carry; undefined for the form's notice
export function noteFieldOf(
  message: string,
  draft: readonly MemoryEntry[],
): string | undefined {
  const words = message.replace(/^entries: /, "");
  const named =
    /^The (topic|text) of (.+?) (?:is|must) /.exec(words) ??
    /^(?:the )?(topic|text) of (.+?) must /i.exec(words) ??
    /^The (topic) (.+?) is repeated/.exec(words) ??
    /Cut or remove (.+)\.$/.exec(words);
  if (named === null) return undefined;
  const kind = named.length === 3 ? named[1]!.toLowerCase() : "text";
  const name = named.length === 3 ? named[2]! : named[1]!;
  const place = /^entry (\d+)$/.exec(name);
  // the server counts the entries sent, which leave the blank boxes out
  const sent = draft.flatMap((entry, index) => (blank(entry) ? [] : [index]));
  const index =
    place !== null
      ? (sent[Number(place[1]) - 1] ?? -1)
      : draft.findIndex(
          (entry) =>
            entry.topic.trim().toLowerCase() === name.trim().toLowerCase(),
        );
  if (index < 0 || index >= draft.length) return undefined;
  return kind === "topic" ? topicField(index) : textField(index);
}
