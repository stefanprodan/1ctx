// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Part of a file changed by exact replacement, as an agent's editor
// does: each old matches once in the text it read, so the order of the
// pairs never changes the result and no edit matches another's text.

import { BadRequest } from "../lib/errors.ts";

// one replacement; old is non-empty
export type KnowledgeEdit = { old: string; new: string };

// the pairs one edit may carry
export const MAX_EDITS = 50;

// the text with every pair applied, or a refusal naming the first pair
// at fault by its position from 1; every old is matched against the
// text as given, before any pair applies. The result is not checked as
// text here: the caller checks it as a page replace's text
export function applyEdits(
  text: string,
  edits: readonly KnowledgeEdit[],
): string {
  if (edits.length === 0 || edits.length > MAX_EDITS) {
    throw new BadRequest(`edits must hold 1 to ${MAX_EDITS} pairs`);
  }
  const spans = edits.map((edit, i) => {
    const name = `edit ${i + 1}`;
    if (edit.old === "") throw new BadRequest(`${name}: old is empty`);
    const start = text.indexOf(edit.old);
    if (start === -1) throw new BadRequest(`${name}: no match`);
    // a second match, overlapping too, and no further: counting them all
    // costs their number times old's length on repetitive text
    if (text.indexOf(edit.old, start + 1) !== -1) {
      throw new BadRequest(`${name}: matches more than once`);
    }
    return { index: i, start, end: start + edit.old.length, edit };
  });
  // in pair order, so the later pair is the one named
  for (const span of spans) {
    const other = spans.find(
      (earlier) =>
        earlier.index < span.index &&
        earlier.start < span.end &&
        span.start < earlier.end,
    );
    if (other !== undefined) {
      throw new BadRequest(
        `edit ${span.index + 1}: overlaps edit ${other.index + 1}`,
      );
    }
  }
  let out = "";
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, span.start) + span.edit.new;
    at = span.end;
  }
  return out + text.slice(at);
}
