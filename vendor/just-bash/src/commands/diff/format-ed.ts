/**
 * (1ctx) GNU diff's ed script (-e), its forward form (-f) and the RCS
 * format (-n). An ed script runs from the last change to the first, so
 * its line numbers hold as it edits; a line that is only a dot is written
 * as two and fixed with `s/.//`. RCS says how many lines each command
 * takes and writes an incomplete last line as it is.
 */

import type { Change } from "./hunks.js";
import { expandTabs, type Lines } from "./lines.js";

/** `f,l`, or the one number when the range has one line or none. */
function range(sep: string, a0: number, a1: number): string {
  return a1 - a0 > 1 ? `${a0 + 1}${sep}${a1}` : `${a1}`;
}

function letter(change: Change): string {
  if (change.b0 === change.b1) return "d";
  return change.a0 === change.a1 ? "a" : "c";
}

export type Charge = (steps: number) => void;

/** A line's text as -t leaves it, without its newline. */
function lineText(
  file: Lines,
  i: number,
  tabSize: number,
  charge: Charge,
): string {
  const line = file.lines[i];
  return tabSize > 0 ? expandTabs(line, tabSize, charge) : line;
}

export function formatEd(
  b: Lines,
  changes: Change[],
  tabSize: number,
  charge: Charge,
  out: string[],
): void {
  for (let k = changes.length - 1; k >= 0; k--) {
    const change = changes[k];
    const { a0, a1, b0, b1 } = change;
    out.push(`${range(",", a0, a1)}${letter(change)}\n`);
    if (b0 === b1) continue;
    let inserting = true;
    for (let y = b0; y < b1; y++) {
      if (!inserting) {
        out.push("a\n");
        inserting = true;
      }
      if (b.lines[y] === ".") {
        // a dot alone would end the insert
        out.push("..\n.\ns/.//\n");
        inserting = false;
      } else {
        out.push(lineText(b, y, tabSize, charge), "\n");
      }
    }
    if (inserting) out.push(".\n");
  }
}

export function formatForwardEd(
  b: Lines,
  changes: Change[],
  tabSize: number,
  charge: Charge,
  out: string[],
): void {
  for (const change of changes) {
    const { a0, a1, b0, b1 } = change;
    out.push(`${letter(change)}${range(" ", a0, a1)}\n`);
    if (b0 === b1) continue;
    for (let y = b0; y < b1; y++)
      out.push(lineText(b, y, tabSize, charge), "\n");
    out.push(".\n");
  }
}

export function formatRcs(
  b: Lines,
  changes: Change[],
  tabSize: number,
  charge: Charge,
  out: string[],
): void {
  for (const { a0, a1, b0, b1 } of changes) {
    if (a1 > a0) out.push(`d${a0 + 1} ${a1 - a0}\n`);
    if (b1 === b0) continue;
    out.push(`a${a1} ${b1 - b0}\n`);
    for (let y = b0; y < b1; y++) {
      out.push(lineText(b, y, tabSize, charge));
      if (y < b.lines.length - 1 || !b.incomplete) out.push("\n");
    }
  }
}
