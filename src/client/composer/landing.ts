// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where a transcribed clip lands. A clip outlives the composer that
// recorded it: the user may leave the chat and come back while it is
// transcribed, and the box then on screen read the stored draft before
// the words came. So the words go to whichever box shows the clip's
// draft key now, and to the stored draft only when none does; a box
// that showed stale text would write over them on its next keystroke.
// The clips in flight are kept by key too, so only the composer of the
// chat a clip started in spins.

import { signal } from "@preact/signals";
import { insertText } from "./dictation.ts";
import { readDraft, writeDraftText } from "./draft.ts";

export type Tap = { text: string; cursor: number };

export type Shown = {
  insert: (tap: Tap, words: string) => void;
  fail: (line: string) => void;
};

const shown = new Map<string, Shown>();

// a box shows this draft key; the returned call lets it go, unless a
// later box took the key since
export function showDraft(key: string, box: Shown): () => void {
  shown.set(key, box);
  return () => {
    if (shown.get(key) === box) shown.delete(key);
  };
}

export function landWords(key: string, tap: Tap, words: string): void {
  const box = shown.get(key);
  if (box) box.insert(tap, words);
  else writeDraftText(key, insertText(readDraft(key).text, tap, words).text);
}

// a failure is said only where the clip's chat is on screen; elsewhere
// the draft is as it was and there is nothing to act on
export function landFailure(key: string, line: string): void {
  shown.get(key)?.fail(line);
}

export const transcribing = signal<ReadonlySet<string>>(new Set());

export function markTranscribing(key: string, on: boolean): void {
  const next = new Set(transcribing.value);
  if (on) next.add(key);
  else next.delete(key);
  transcribing.value = next;
}
