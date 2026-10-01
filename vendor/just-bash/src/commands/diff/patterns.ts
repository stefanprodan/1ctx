/**
 * (1ctx diff) diff's regular expressions, GNU basic ones as grep reads them on
 * RE2: -I marks a change ignorable when every line of it matches, -B when
 * every line is blank, and -p and -F find the heading each hunk prints.
 */

import { createUserRegex } from "../../regex/index.js";
import { translateGnu } from "../search-engine/gnu-regex.js";
import type { Change, Hunk } from "./hunks.js";
import { decodeLine, type Lines } from "./lines.js";

export type LineTest = (line: string) => boolean;

/** Whether a line matches any of the patterns; throws on a bad one. */
export function anyPattern(patterns: string[]): LineTest {
  const regexes = patterns.map((p) =>
    createUserRegex(translateGnu(p, "basic").source),
  );
  return (line) => {
    const text = decodeLine(line) ?? line;
    return regexes.some((re) => re.test(text));
  };
}

const BLANK = /^[\t\v\f\r ]*$/;

/**
 * Marks each change whose every line is blank (-B) or matches -I. A line
 * of spaces is blank only when white space is ignored, as GNU's manual has
 * it.
 */
export function markIgnorable(
  changes: Change[],
  a: Lines,
  b: Lines,
  blankLines: boolean,
  spaceIgnored: boolean,
  matching: LineTest | null,
): void {
  const ignorable = (line: string) =>
    (blankLines && (line === "" || (spaceIgnored && BLANK.test(line)))) ||
    (matching !== null && matching(line));
  for (const change of changes) {
    let all = true;
    for (let x = change.a0; all && x < change.a1; x++) {
      all = ignorable(a.lines[x]);
    }
    for (let y = change.b0; all && y < change.b1; y++) {
      all = ignorable(b.lines[y]);
    }
    change.ignorable = all;
  }
}

/** GNU prints this many bytes of a heading. */
const HEADING_BYTES = 40;

/**
 * The heading of each hunk in turn: the nearest line of the first file
 * before it that matches, cut at 40 bytes with its trailing blanks
 * dropped. Hunks come in order, so each search stops where the last began.
 */
export function headings(a: Lines, test: LineTest): (hunk: Hunk) => string {
  let searched = 0;
  let found = -1;
  return (hunk) => {
    for (let x = hunk.a0 - 1; x >= searched; x--) {
      if (test(a.lines[x])) {
        found = x;
        break;
      }
    }
    searched = Math.max(searched, hunk.a0);
    if (found < 0) return "";
    return a.lines[found].slice(0, HEADING_BYTES).replace(/[\t\v\f\r ]+$/, "");
  };
}
