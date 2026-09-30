// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a waiting message hands its chat's composer. Edit opens an edit:
// the box holds the message's text alone, the draft set aside until
// Save or Cancel gives it back, so the draft never joins the edited
// message. Send again puts the text of a message that was not sent
// before the draft, to be sent anew. Remove of the message open for an
// edit closes the edit. While an edit is open a second Edit or Send
// again is refused with words, so the open edit's text is never lost.

import { signal } from "@preact/signals";
import type { DraftEdit } from "./draft.ts";

export type Handoff =
  | {
      kind: "edit";
      sessionId: string;
      row: { id: string; revision: number; text: string };
    }
  | { kind: "again"; sessionId: string; text: string }
  | { kind: "close"; sessionId: string; id: string; words: string };

// the edit open in a chat's composer, mirrored from its draft
export type Editing = DraftEdit & { sessionId: string };

export const EDITING = "Editing a queued message";
export const EDIT_OPEN = "Save or cancel the open edit first.";
// an edit that could not land keeps its text, with the draft after it
export const EDIT_LOST =
  "The message started or changed before the edit. The text is kept here.";
export const EDIT_GONE =
  "The message left the queue before the edit. The text is kept here.";
export const EDIT_NOT_SENT = "The message was not sent. The text is kept here.";
export const EDIT_REMOVED = "The message was removed. The edit is closed.";

// the rows a Remove here is deleting: the edit open on one waits for the
// Remove's own words, not the words for a row gone elsewhere
export const removing = new Set<string>();

// taken by the composer of its chat
export const handoff = signal<Handoff | null>(null);
export const editing = signal<Editing | null>(null);

export function handOver(next: Handoff): void {
  handoff.value = next;
}

export const editOpen = (sessionId: string): boolean =>
  editing.value?.sessionId === sessionId;

// the text first, then the draft after a blank line
export function merged(text: string, draft: string): string {
  return draft.trim() === "" ? text : `${text}\n\n${draft}`;
}

// what the box holds after a handoff over its text and the edit open,
// and the edit then open; null when the handoff changes nothing
export function takeHandoff(
  next: Handoff,
  text: string,
  open: DraftEdit | null,
): { text: string; edit: DraftEdit | undefined; words: string | null } | null {
  if (next.kind === "close") {
    return open?.id === next.id
      ? { text: open.before, edit: undefined, words: next.words }
      : null;
  }
  if (open !== null) return null;
  if (next.kind === "again") {
    return { text: merged(next.text, text), edit: undefined, words: null };
  }
  const { id, revision } = next.row;
  return {
    text: next.row.text,
    edit: { id, revision, before: text },
    words: null,
  };
}
