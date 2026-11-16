// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { cutSearchLine } from "../../shared/search.ts";

type OutlineRow = { line: number; level: number; text: string };

const isBlank = (char: string | undefined) => char === " " || char === "\t";

// A line's ATX heading: one to six #, then blanks and text or nothing,
// an optional \r at the end and no other line break, and a closing run
// of # after a blank dropped. Regexes for these backtrack over a long
// blank run, once per blank, so the line is walked.
function atxHeading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (line[level] === "#") level++;
  if (level === 0 || level > 6) return null;
  let start = level;
  while (isBlank(line[start])) start++;
  let end = line.endsWith("\r") ? line.length - 1 : line.length;
  if (start === level && start < end) return null;
  if (/[\r\u2028\u2029]/.test(line.slice(start, end))) return null;
  // the closing run: blanks, at least one #, blanks, after a blank
  let close = end;
  while (close > start && isBlank(line[close - 1])) close--;
  let hashes = close;
  while (hashes > start && line[hashes - 1] === "#") hashes--;
  if (hashes < close && hashes > start && isBlank(line[hashes - 1])) {
    end = hashes - 1;
    while (end > start && isBlank(line[end - 1])) end--;
  }
  return { level, text: line.slice(start, end) };
}

export function outlineRows(text: string): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const [index, line] of text.split("\n").entries()) {
    if (fence !== null) {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*\r?$/);
      if (
        close !== null &&
        close[1]![0] === fence.marker &&
        close[1]!.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening !== null) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    const heading = atxHeading(line);
    if (heading === null) continue;
    rows.push({
      line: index + 1,
      level: heading.level,
      text: cutSearchLine(heading.text, index + 1, { from: 0, to: 0 }).text,
    });
  }
  return rows;
}
