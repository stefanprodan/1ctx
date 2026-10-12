// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  type KnowledgeSearchResponse,
  SEARCH_NAMES,
  SEARCH_PAGE,
} from "../../shared/api/knowledge.ts";
import type {
  KnowledgeFile,
  KnowledgeSearchHit,
} from "../../shared/contracts/knowledge.ts";
import {
  bestLines,
  creditedCount,
  holdsAll,
  searchTerms,
} from "../../shared/search.ts";
import { isKnowledgeName } from "../../shared/words.ts";
import { BadRequest, TooManyRequests } from "../lib/errors.ts";

// BM25 with Lucene's IDF
const K1 = 1.2;
const B = 0.75;
const NAME_ALL = 1.5;
const NAME_SOME = 1.2;

export type SearchSource = {
  // every live file, in name order
  files(): Iterable<KnowledgeFile>;
  // null for a file gone since its row was read
  text(fileId: string): string | null;
};

// the query's words, refused when it holds none
export function queryTerms(q: string): string[] {
  const terms = searchTerms(q);
  if (terms.length === 0) throw new BadRequest("q must hold a word");
  return terms;
}

export type SearchCursor = { score: number; name: string };

// the last row's score and name; the score's shortest form reads back
// to the same number
export const cursorOf = (cursor: SearchCursor): string =>
  `${cursor.score}:${cursor.name}`;

// null when it is not one cursorOf wrote
export function readCursor(value: string): SearchCursor | null {
  const at = value.indexOf(":");
  if (at < 0) return null;
  const head = value.slice(0, at);
  const name = value.slice(at + 1);
  if (!/^\d+(\.\d+)?(e[-+]\d+)?$/.test(head) || !isKnowledgeName(name)) {
    return null;
  }
  const score = Number(head);
  return Number.isFinite(score) ? { score, name } : null;
}

type Found = { file: KnowledgeFile; text: string; counts: number[] };
type Ranked = { file: KnowledgeFile; text: string; score: number };

// Every file is read on every page: the IDF needs the whole project, and
// the project's cap bounds the scan. A write between two pages changes
// the scores, so a row may then repeat or be skipped.
export function search(
  source: SearchSource,
  q: string,
  after: string | null,
): KnowledgeSearchResponse {
  const terms = queryTerms(q);
  const cursor = after === null ? null : readCursor(after);
  if (after !== null && cursor === null) {
    throw new BadRequest("after must be a search cursor");
  }
  const found: Found[] = [];
  const names: KnowledgeFile[] = [];
  let namesTotal = 0;
  const df = terms.map(() => 0);
  let scanned = 0;
  let bytes = 0;
  for (const file of source.files()) {
    const text = source.text(file.id);
    if (text === null) continue;
    scanned++;
    bytes += file.bytes;
    const lower = text.toLowerCase();
    const counts = terms.map((term) => creditedCount(lower, term));
    counts.forEach((count, i) => {
      if (count > 0) df[i]!++;
    });
    if (terms.every((term) => lower.includes(term)) && holdsAll(text, terms)) {
      found.push({ file, text, counts });
    } else if (cursor === null && holdsAll(file.name, terms)) {
      namesTotal++;
      if (names.length < SEARCH_NAMES) names.push(file);
    }
  }
  const avg = Math.max(1, bytes / Math.max(1, scanned));
  const idf = df.map((n) => Math.log(1 + (scanned - n + 0.5) / (n + 0.5)));
  const ranked: Ranked[] = found.map(({ file, text, counts }) => {
    const norm = K1 * (1 - B + (B * file.bytes) / avg);
    let score = 0;
    counts.forEach((tf, i) => {
      score += (idf[i]! * tf * (K1 + 1)) / (tf + norm);
    });
    const name = file.name.toLowerCase();
    const named = terms.filter((term) => name.includes(term)).length;
    if (named === terms.length) score *= NAME_ALL;
    else if (named > 0) score *= NAME_SOME;
    return { file, text, score };
  });
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0),
  );
  let start = 0;
  if (cursor !== null) {
    start = ranked.findIndex(
      (row) =>
        row.score < cursor.score ||
        (row.score === cursor.score && row.file.name > cursor.name),
    );
    if (start < 0) start = ranked.length;
  }
  const page = ranked.slice(start, start + SEARCH_PAGE);
  const last = page.at(-1);
  const next =
    last !== undefined && start + SEARCH_PAGE < ranked.length
      ? cursorOf({ score: last.score, name: last.file.name })
      : null;
  const files: KnowledgeSearchHit[] = page.map(({ file, text }) => ({
    file,
    ...bestLines(text, terms),
  }));
  return { names, namesTotal, files, next };
}

// one scan per user at a time, should the scan ever yield
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
