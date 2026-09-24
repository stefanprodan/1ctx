/**
 * (1ctx) rg --json's messages, moved out of rg-search.ts: a file's begin,
 * match and end, and the run's summary.
 */

import type { UserRegex } from "../../regex/index.js";
import { edgesOk, type WordEdges } from "../search-engine/index.js";

interface JsonSubmatch {
  match: { text: string };
  start: number;
  end: number;
  replacement?: { text: string };
}

interface JsonMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
    submatches: JsonSubmatch[];
  };
}

const ZERO = { secs: 0, nanos: 0, human: "0s" };

/** The messages of one file that matched. */
export function fileMessages(
  file: string,
  content: string,
  regex: UserRegex,
  edges: WordEdges,
  replace: string | null,
  matchCount: number,
): string[] {
  const messages = [
    JSON.stringify({ type: "begin", data: { path: { text: file } } }),
  ];
  const lines = content.split("\n");
  let lineOffset = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    regex.lastIndex = 0;
    const submatches: JsonSubmatch[] = [];
    for (
      let match = regex.exec(line);
      match !== null;
      match = regex.exec(line)
    ) {
      const end = match.index + match[0].length;
      // -w, \< and \> are the matcher's checks, not the pattern's
      if (edgesOk(edges, line, match.index, end)) {
        const submatch: JsonSubmatch = {
          match: { text: match[0] },
          start: match.index,
          end,
        };
        if (replace !== null) submatch.replacement = { text: replace };
        submatches.push(submatch);
      }
      if (match[0].length === 0) regex.lastIndex++;
    }
    if (submatches.length > 0) {
      const message: JsonMatch = {
        type: "match",
        data: {
          path: { text: file },
          lines: { text: `${line}\n` },
          line_number: lineIdx + 1,
          absolute_offset: lineOffset,
          submatches,
        },
      };
      messages.push(JSON.stringify(message));
    }
    lineOffset += line.length + 1;
  }
  messages.push(
    JSON.stringify({
      type: "end",
      data: {
        path: { text: file },
        binary_offset: null,
        stats: {
          elapsed: ZERO,
          searches: 1,
          searches_with_match: 1,
          bytes_searched: content.length,
          bytes_printed: 0,
          matched_lines: matchCount,
          matches: matchCount,
        },
      },
    }),
  );
  return messages;
}

/** The run's last message. */
export function summaryMessage(
  searches: number,
  withMatch: number,
  bytesSearched: number,
  matches: number,
): string {
  return JSON.stringify({
    type: "summary",
    data: {
      elapsed_total: ZERO,
      stats: {
        elapsed: ZERO,
        searches,
        searches_with_match: withMatch,
        bytes_searched: bytesSearched,
        bytes_printed: 0,
        matched_lines: matches,
        matches,
      },
    },
  });
}
