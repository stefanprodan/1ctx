// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { searchTerms, termRanges } from "../../shared/search.ts";

// a name split where its folder ends, the folder drawn faint
export function pathParts(name: string): { dir: string; base: string } {
  const at = name.lastIndexOf("/") + 1;
  return { dir: name.slice(0, at), base: name.slice(at) };
}

// a text in runs, every place it holds a word of q marked, not
// case-sensitive
type Marked = { text: string; mark: boolean }[];

export function marked(text: string, q: string): Marked {
  const out: Marked = [];
  let from = 0;
  for (const range of termRanges(text, searchTerms(q))) {
    if (range.from > from) {
      out.push({ text: text.slice(from, range.from), mark: false });
    }
    out.push({ text: text.slice(range.from, range.to), mark: true });
    from = range.to;
  }
  if (from < text.length) out.push({ text: text.slice(from), mark: false });
  return out;
}
