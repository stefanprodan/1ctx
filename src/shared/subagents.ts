// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's result is its answer, then a blank line and the files
// part: what came back to the parent's /tmp and what did not. The server
// writes it and the work fold draws the answer once with only the files
// after it, so both read the headings from here.

export const filesHeading = (folder: string) => `Files in /tmp/${folder}/:`;

// what did not come back: past the parent's /tmp caps, or a name its
// rule refuses there
export const NOT_COPIED =
  "Not copied back, over this chat's /tmp limits or names:";

const STARTS = ["\n\nFiles in /tmp/", `\n\n${NOT_COPIED}`];

// a line the files part may hold, the display cut's ellipsis included
const isFilesLine = (line: string) =>
  /^Files in \/tmp\/[^/]+\/:$/.test(line) ||
  line === NOT_COPIED ||
  line.startsWith("/tmp/") ||
  /^and \d+ more( in \/tmp\/[^/]+\/)?$/.test(line) ||
  line === "..." ||
  line === "…";

// the files part of a result, "" when it has none. An answer may hold a
// line that reads like a heading, so a start counts only when every line
// after it belongs to the files part
export function filesPart(result: string): string {
  const starts = STARTS.flatMap((start) => {
    const found: number[] = [];
    for (let at = result.indexOf(start); at >= 0; ) {
      found.push(at);
      at = result.indexOf(start, at + 1);
    }
    return found;
  }).sort((a, b) => a - b);
  for (const at of starts) {
    const part = result.slice(at + 2);
    if (part.split("\n").every(isFilesLine)) return part;
  }
  return "";
}
