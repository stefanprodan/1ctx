/**
 * (1ctx diff) GNU diff's context format: a row of stars over each hunk, the
 * first file's lines under `*** F,L ****` and the second's under
 * `--- F,L ----`, a side left out when it has no change; a line changed on
 * both sides is `! `, one only deleted `- `, one only inserted `+ `.
 */

import type { Hunk } from "./hunks.js";
import type { Lines } from "./lines.js";
import { type LineStyle, writeLine } from "./output.js";

function range(start: number, end: number): string {
  const count = end - start;
  if (count === 0) return `${start}`;
  if (count === 1) return `${start + 1}`;
  return `${start + 1},${end}`;
}

export function formatContext(
  a: Lines,
  b: Lines,
  hunks: Hunk[],
  style: LineStyle,
  out: string[],
  heading: (hunk: Hunk) => string = () => "",
): void {
  for (const hunk of hunks) {
    const title = heading(hunk);
    out.push(`***************${title ? ` ${title}` : ""}\n`);
    out.push(`*** ${range(hunk.a0, hunk.a1)} ****\n`);
    if (hunk.changes.some((c) => c.a1 > c.a0)) {
      let x = hunk.a0;
      for (const change of hunk.changes) {
        for (; x < change.a0; x++) writeLine(out, " ", " ", a, x, style);
        const mark = change.b1 > change.b0 ? "!" : "-";
        for (; x < change.a1; x++) writeLine(out, mark, " ", a, x, style);
      }
      for (; x < hunk.a1; x++) writeLine(out, " ", " ", a, x, style);
    }
    out.push(`--- ${range(hunk.b0, hunk.b1)} ----\n`);
    if (hunk.changes.some((c) => c.b1 > c.b0)) {
      let y = hunk.b0;
      for (const change of hunk.changes) {
        for (; y < change.b0; y++) writeLine(out, " ", " ", b, y, style);
        const mark = change.a1 > change.a0 ? "!" : "+";
        for (; y < change.b1; y++) writeLine(out, mark, " ", b, y, style);
      }
      for (; y < hunk.b1; y++) writeLine(out, " ", " ", b, y, style);
    }
  }
}
