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

// Whether an occurrence counts toward a file's rank: a whole word, or
// one carrying a plain English ending. Inner ones (claim in reclaim)
// still match but score nothing.
const ENDINGS = new Set(["s", "es", "d", "ed", "ing", "er", "ers"]);
// scripts written without spaces between words
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;

function isWord(code: number): boolean {
  if (code < 0) return false;
  if (code < 0x80) {
    return (
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a)
    );
  }
  return WORD_CHAR.test(String.fromCodePoint(code));
}

function codeBefore(text: string, at: number): number {
  if (at <= 0) return -1;
  const unit = text.charCodeAt(at - 1);
  if (isLow(unit) && at >= 2) return text.codePointAt(at - 2)!;
  return unit;
}

const codeAt = (text: string, at: number): number =>
  at < text.length ? text.codePointAt(at)! : -1;

// the letters and digits glued at at, or null past the longest ending
function glued(text: string, at: number): string | null {
  let end = at;
  while (isWord(codeAt(text, end))) {
    end += codeAt(text, end) > 0xffff ? 2 : 1;
    if (end - at > 3) return null;
  }
  return text.slice(at, end);
}

// the credited occurrences of a lowercased term in lowercased text
export function creditedCount(lower: string, term: string): number {
  if (term === "") return 0;
  const step = (at: number) => at + term.length;
  if (UNSPACED.test(term)) {
    let count = 0;
    for (
      let at = lower.indexOf(term);
      at >= 0;
      at = lower.indexOf(term, step(at))
    ) {
      count++;
    }
    return count;
  }
  const checkStart = isWord(term.codePointAt(0)!);
  const checkEnd = isWord(codeBefore(term, term.length));
  const startOk = (at: number) => !checkStart || !isWord(codeBefore(lower, at));
  let count = 0;
  for (
    let at = lower.indexOf(term);
    at >= 0;
    at = lower.indexOf(term, step(at))
  ) {
    if (!startOk(at)) continue;
    if (!checkEnd) {
      count++;
      continue;
    }
    const rest = glued(lower, at + term.length);
    if (rest === "" || (rest !== null && ENDINGS.has(rest))) count++;
  }
  // release in releasing: the stem never holds the term, so no overlap
  if (term.length > 1 && term.endsWith("e")) {
    const stem = `${term.slice(0, -1)}ing`;
    for (
      let at = lower.indexOf(stem);
      at >= 0;
      at = lower.indexOf(stem, at + stem.length)
    ) {
      if (startOk(at) && !isWord(codeAt(lower, at + stem.length))) count++;
    }
  }
  return count;
}

type Candidate = {
  number: number;
  line: string;
  held: number;
  credited: number;
};

// the lines holding any term, counted, and the max best kept in line
// order: most distinct terms held, then most credited, then earliest
export function bestLines(
  text: string,
  terms: readonly string[],
  max = SEARCH_LINES,
): { count: number; lines: SearchLine[] } {
  let count = 0;
  const kept: Candidate[] = [];
  if (terms.length === 0) return { count, lines: [] };
  const better = (a: Candidate, b: Candidate) =>
    a.held - b.held || a.credited - b.credited || b.number - a.number;
  let start = 0;
  for (let number = 1; start <= text.length; number++) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const lower = line.toLowerCase();
    let held = 0;
    let credited = 0;
    for (const term of terms) {
      if (!lower.includes(term)) continue;
      held++;
      if (creditedCount(lower, term) > 0) credited++;
    }
    if (held === 0) continue;
    count++;
    const candidate = { number, line, held, credited };
    if (kept.length < max) {
      kept.push(candidate);
      continue;
    }
    // the weakest kept gives way to a better line
    let weakest = 0;
    for (let i = 1; i < kept.length; i++) {
      if (better(kept[i]!, kept[weakest]!) < 0) weakest = i;
    }
    if (max > 0 && better(candidate, kept[weakest]!) > 0) {
      kept[weakest] = candidate;
    }
  }
  kept.sort((a, b) => a.number - b.number);
  const lines = kept.map(({ line, number }) => {
    // a word folded in context (a final sigma) may not map back
    const at = termRanges(line, terms)[0] ?? { from: 0, to: 0 };
    return cutSearchLine(line, number, at);
  });
  return { count, lines };
}
