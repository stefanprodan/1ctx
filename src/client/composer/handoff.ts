// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A waiting message's text handed to its chat's composer: Edit puts it
// there to be saved over the row, Send again to be sent anew. The text
// goes before the draft, so nothing typed is lost. While an edit is
// open the composer saves instead of sending; Cancel gives the draft
// back as it was.

import { signal } from "@preact/signals";

export type Handoff = {
  sessionId: string;
  text: string;
  // the row an edit saves over, with the revision it was read at
  edit: { id: string; revision: number } | null;
};

export type Editing = {
  sessionId: string;
  id: string;
  revision: number;
  // the draft before the edit, for Cancel
  before: string;
};

export const EDITING = "Editing a queued message";
// an edit that could not land keeps its text as the draft
export const EDIT_LOST =
  "The message started or changed before the edit. The text is kept here.";
export const EDIT_GONE =
  "The message left the queue before the edit. The text is kept here.";

// taken by the composer of its chat
export const handoff = signal<Handoff | null>(null);
export const editing = signal<Editing | null>(null);

export function handOver(next: Handoff): void {
  handoff.value = next;
}

// the text first, then the draft after a blank line
export function merged(text: string, draft: string): string {
  return draft.trim() === "" ? text : `${text}\n\n${draft}`;
}

// what a composer does with a handoff over its draft: the text to show,
// and the edit it opens. An edit already open gives its draft back
// first, so a second Edit replaces the first
export function takeHandoff(
  next: Handoff,
  draft: string,
  open: Editing | null,
): { text: string; editing: Editing | null } {
  const base = open?.sessionId === next.sessionId ? open.before : draft;
  return {
    text: merged(next.text, base),
    editing:
      next.edit === null
        ? null
        : { sessionId: next.sessionId, ...next.edit, before: base },
  };
}
