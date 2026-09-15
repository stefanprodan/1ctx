// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the note card: the count against the limit, who wrote
// the note last, and the draft an edit works on, tested without a DOM.

import type { Memory } from "../../../shared/contracts/memory.ts";
import {
  MEMORY_CHARS,
  memoryChars,
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

export function countLine(entries: readonly string[]): string {
  return `${memoryChars(entries)} of ${MEMORY_CHARS} characters`;
}

// the entries a save sends: cleaned, empty ones dropped; the problem
// when the result passes the budget
export function draftEntries(draft: readonly string[]): string[] {
  return normalize(draft);
}

export function draftDirty(
  draft: readonly string[],
  entries: readonly string[],
): boolean {
  const next = normalize(draft);
  return (
    next.length !== entries.length ||
    next.some((entry, index) => entry !== entries[index])
  );
}
