// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Plain text search over a project's live files, a page at a time. No
// index: the texts are read one at a time in name order, so memory stays
// one file whatever the base holds.

import {
  type KnowledgeSearchResponse,
  SEARCH_LINE_CHARS,
  SEARCH_LINES,
  SEARCH_NAMES,
  SEARCH_PAGE,
} from "../../shared/api/knowledge.ts";
import type {
  KnowledgeFile,
  KnowledgeSearchHit,
  KnowledgeSearchLine,
} from "../../shared/contracts/knowledge.ts";
import { TooManyRequests } from "../lib/errors.ts";

// the text read a request at most; past it the page ends early with
// next set, so a large base is searched a page at a time
export const SEARCH_SCAN_BYTES = 8 * 1024 * 1024;

// Rows come without text and a text is read only once it fits what is
// left of the budget, so a request never loads past it but for the one
// file every page reads.
export type SearchSource = {
  // the live files past the name, in name order
  files(after: string | null): Iterable<KnowledgeFile>;
  // those whose name holds the lowercased query
  named(after: string | null, query: string): Iterable<KnowledgeFile>;
  // empty for a file gone since its row was read
  text(fileId: string): string;
};

// The cursor is a name, so a rename between two pages may move a file
// across it: it can then show twice or not at all.
export function search(
  source: SearchSource,
  q: string,
  after: string | null,
  budget = SEARCH_SCAN_BYTES,
): KnowledgeSearchResponse {
  const query = q.toLowerCase();
  const first = after === null;
  const files: KnowledgeSearchHit[] = [];
  const names: KnowledgeFile[] = [];
  let namesTotal = 0;
  const name = (file: KnowledgeFile) => {
    namesTotal++;
    if (names.length < SEARCH_NAMES) names.push(file);
  };
  let read = 0;
  let last: string | null = null;
  let next: string | null = null;
  for (const file of source.files(after)) {
    if (last !== null && read + file.bytes > budget) {
      next = last;
      break;
    }
    read += file.bytes;
    last = file.name;
    const hit = matchText(source.text(file.id), query);
    if (hit === null) {
      if (first && file.name.toLowerCase().includes(query)) name(file);
      continue;
    }
    if (files.length === SEARCH_PAGE) {
      next = files[SEARCH_PAGE - 1]!.file.name;
      break;
    }
    files.push({ file, ...hit });
  }
  if (!first || next === null) return { names, namesTotal, files, next };
  // the names past where the page stopped, their text read while the
  // budget lasts and, past it, listed on the name alone
  let spent = false;
  for (const file of source.named(last, query)) {
    if (!spent && read + file.bytes > budget) spent = true;
    if (spent) {
      name(file);
      continue;
    }
    read += file.bytes;
    if (!source.text(file.id).toLowerCase().includes(query)) name(file);
  }
  return { names, namesTotal, files, next };
}

// query is lowercased; null when no line holds it
export function matchText(
  text: string,
  query: string,
): { count: number; lines: KnowledgeSearchLine[] } | null {
  if (!text.toLowerCase().includes(query)) return null;
  let count = 0;
  const lines: KnowledgeSearchLine[] = [];
  let start = 0;
  for (let number = 1; start <= text.length; number++) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const at = findIn(line, query);
    if (at === null) continue;
    count++;
    if (lines.length < SEARCH_LINES) lines.push(cut(line, number, at));
  }
  return count === 0 ? null : { count, lines };
}

// where the query sits in the line as written. Lowercasing can change a
// string's length, so each lowered unit maps back to its source unit
function findIn(
  line: string,
  query: string,
): { from: number; to: number } | null {
  const lower = line.toLowerCase();
  if (lower.length === line.length) {
    const from = lower.indexOf(query);
    return from < 0 ? null : { from, to: from + query.length };
  }
  let folded = "";
  const source: number[] = [];
  for (let i = 0; i < line.length; ) {
    const point = line.codePointAt(i)!;
    const width = point > 0xffff ? 2 : 1;
    const lowered = line.slice(i, i + width).toLowerCase();
    folded += lowered;
    for (let j = 0; j < lowered.length; j++) source.push(i);
    i += width;
  }
  source.push(line.length);
  const from = folded.indexOf(query);
  if (from < 0) return null;
  const last = source[from + query.length - 1]!;
  const lastWidth = line.codePointAt(last)! > 0xffff ? 2 : 1;
  return { from: source[from]!, to: last + lastWidth };
}

function cut(
  line: string,
  number: number,
  at: { from: number; to: number },
): KnowledgeSearchLine {
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

// one scan per user at a time; the scan is synchronous today, and this
// holds should it ever yield
export function oneAtATime<T>(
  running: Set<string>,
  userId: string,
  scan: () => T,
): T {
  if (running.has(userId)) {
    throw new TooManyRequests("a search is already running");
  }
  running.add(userId);
  try {
    return scan();
  } finally {
    running.delete(userId);
  }
}
