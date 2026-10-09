// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the start of text within chars UTF-16 units, never half a surrogate
// pair, which a strict JSON reader refuses and SQLite stores as U+FFFD
export function cutAt(text: string, chars: number): string {
  if (text.length <= chars) return text;
  if (chars <= 0) return "";
  const last = text.charCodeAt(chars - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? chars - 1 : chars);
}

// a cut text ends in an ellipsis inside the cap, so the model never
// reads a cut as the whole text
export function cutText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${cutAt(text, cap - 1).trimEnd()}…`;
}

// the first max code points, for caps counted in characters a user sees
export function cutCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  return [...text].slice(0, max).join("");
}

// runs of whitespace as one space, trimmed
export const oneLine = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

// a period closing `e.g` or `i.e` is no sentence end; nothing else is
// skipped, so two real sentences never merge
const SENTENCE_END = /[.!?](?=\s|$)/g;
const ABBREVIATION = /(?:^|[^\p{L}\p{N}_])(?:e\.g|i\.e)$/iu;

// the first sentence of a description, on one line, cut at cap
export function firstSentence(text: string, cap: number): string {
  const line = oneLine(text);
  let sentence = line;
  for (const end of line.matchAll(SENTENCE_END)) {
    const before = line.slice(0, end.index);
    if (end[0] === "." && ABBREVIATION.test(before)) continue;
    sentence = `${before}${end[0]}`;
    break;
  }
  return cutText(sentence, cap);
}
