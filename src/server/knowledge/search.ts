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
import { holdsAll, matchText, searchTerms } from "../../shared/search.ts";
import { BadRequest, TooManyRequests } from "../lib/errors.ts";

// the text read a request at most; past it the page ends early with
// next set, so a large base is searched a page at a time
export const SEARCH_SCAN_BYTES = 8 * 1024 * 1024;

// Rows come without text and a text is read only once it fits what is
// left of the budget, so a request never loads past it but for the one
// file every page reads.
export type SearchSource = {
  // the live files past the name, in name order
  files(after: string | null): Iterable<KnowledgeFile>;
  // those whose name holds every one of the lowercased terms
  named(
    after: string | null,
    terms: readonly string[],
  ): Iterable<KnowledgeFile>;
  // empty for a file gone since its row was read
  text(fileId: string): string;
};

// the query's words, refused when it holds none
export function queryTerms(q: string): string[] {
  const terms = searchTerms(q);
  if (terms.length === 0) throw new BadRequest("q must hold a word");
  return terms;
}

// The cursor is a name, so a rename between two pages may move a file
// across it: it can then show twice or not at all.
export function search(
  source: SearchSource,
  q: string,
  after: string | null,
  budget = SEARCH_SCAN_BYTES,
): KnowledgeSearchResponse {
  const terms = queryTerms(q);
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
    const hit = matchText(source.text(file.id), terms);
    if (hit === null) {
      if (first && holdsAll(file.name, terms)) name(file);
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
  for (const file of source.named(last, terms)) {
    if (!spent && read + file.bytes > budget) spent = true;
    if (spent) {
      name(file);
      continue;
    }
    read += file.bytes;
    if (!holdsAll(source.text(file.id), terms)) name(file);
  }
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
