// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How a search query matches a text, shared by knowledge search, session
// search and the page that marks their lines. A query is words split on
// whitespace, a double-quoted run being one phrase; a text matches when
// it holds every word in any case, and its hit lines are those holding
// any. Environment neutral: no Bun, no DOM, no packages.

import { SEARCH_LINE_CHARS, SEARCH_LINES } from "./api/knowledge.ts";

// a line holding a word: its number from 1 and its text cut round the
// first word, with where it was cut
export type SearchLine = {
  line: number;
  text: string;
  cutStart: boolean;
  cutEnd: boolean;
};

export type SearchRange = { from: number; to: number };

// the query's words, lowercased, each once. A quote with no closing one
// makes the rest of the query a phrase, so a phrase being typed matches
// as it grows. Empty when the query holds no word
export function searchTerms(q: string): string[] {
  const terms: string[] = [];
  const add = (term: string) => {
    const lowered = term.trim().toLowerCase();
    if (lowered !== "" && !terms.includes(lowered)) terms.push(lowered);
  };
  let word = "";
  let phrase: string | null = null;
  for (const char of q) {
    if (phrase !== null) {
      if (char === '"') {
        add(phrase);
        phrase = null;
      } else {
        phrase += char;
      }
    } else if (char === '"') {
      add(word);
      word = "";
      phrase = "";
    } else if (/\s/.test(char)) {
      add(word);
      word = "";
    } else {
      word += char;
    }
  }
  add(phrase ?? word);
  return terms;
}

// terms as searchTerms gives them
export function holdsAll(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const held = new Set<string>();
  let start = 0;
  while (start <= text.length && held.size < terms.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).toLowerCase();
    start = end + 1;
    for (const term of terms) {
      if (!held.has(term) && line.includes(term)) held.add(term);
    }
  }
  return held.size === terms.length;
}

// null when the text misses a term
export function matchText(
  text: string,
  terms: readonly string[],
): { count: number; lines: SearchLine[] } | null {
  if (!holdsAll(text, terms)) return null;
  const found = matchLines(text, terms);
  return found.count === 0 ? null : found;
}

// the lines holding any term, counted, the first max kept
export function matchLines(
  text: string,
  terms: readonly string[],
  max = SEARCH_LINES,
): { count: number; lines: SearchLine[] } {
  let count = 0;
  const lines: SearchLine[] = [];
  if (terms.length === 0) return { count, lines };
  let start = 0;
  for (let number = 1; start <= text.length; number++) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const lower = line.toLowerCase();
    if (!terms.some((term) => lower.includes(term))) continue;
    count++;
    if (lines.length < max) {
      // a word folded in context (a final sigma) may not map back
      const at = termRanges(line, terms)[0] ?? { from: 0, to: 0 };
      lines.push(cutSearchLine(line, number, at));
    }
  }
  return { count, lines };
}

// where the terms sit in the line as written, in order, overlapping and
// touching ones joined. Lowercasing can change a string's length, so
// each lowered unit maps back to its source unit
export function termRanges(
  line: string,
  terms: readonly string[],
): SearchRange[] {
  const { folded, source } = fold(line);
  const found: SearchRange[] = [];
  for (const term of terms) {
    for (let at = folded.indexOf(term); at >= 0; ) {
      found.push(toSource(line, source, at, at + term.length));
      at = folded.indexOf(term, at + term.length);
    }
  }
  found.sort((a, b) => a.from - b.from || a.to - b.to);
  const joined: SearchRange[] = [];
  for (const range of found) {
    const last = joined.at(-1);
    if (last !== undefined && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      joined.push({ ...range });
    }
  }
  return joined;
}

function fold(line: string): { folded: string; source: number[] | null } {
  const lower = line.toLowerCase();
  if (lower.length === line.length) return { folded: lower, source: null };
  let folded = "";
  const source: number[] = [];
  for (let i = 0; i < line.length; ) {
    const width = line.codePointAt(i)! > 0xffff ? 2 : 1;
    const lowered = line.slice(i, i + width).toLowerCase();
    folded += lowered;
    for (let j = 0; j < lowered.length; j++) source.push(i);
    i += width;
  }
  source.push(line.length);
  return { folded, source };
}

function toSource(
  line: string,
  source: number[] | null,
  from: number,
  to: number,
): SearchRange {
  if (source === null) return { from, to };
  const last = source[to - 1]!;
  const lastWidth = line.codePointAt(last)! > 0xffff ? 2 : 1;
  return { from: source[from]!, to: last + lastWidth };
}

export function cutSearchLine(
  line: string,
  number: number,
  at: SearchRange,
): SearchLine {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (text.length <= SEARCH_LINE_CHARS) {
    return { line: number, text, cutStart: false, cutEnd: false };
  }
  const room = Math.max(0, SEARCH_LINE_CHARS - (at.to - at.from));
  let from = Math.max(0, at.from - Math.floor(room / 2));
  let to = Math.min(text.length, from + SEARCH_LINE_CHARS);
  from = Math.max(0, to - SEARCH_LINE_CHARS);
  // never split a surrogate pair at either end
  if (from > 0 && isLow(text.charCodeAt(from))) from++;
  if (to < text.length && isLow(text.charCodeAt(to))) to--;
  return {
    line: number,
    text: text.slice(from, to),
    cutStart: from > 0,
    cutEnd: to < text.length,
  };
}

function isLow(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
