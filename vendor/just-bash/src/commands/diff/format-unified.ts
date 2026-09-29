/**
 * (1ctx) GNU diff's unified format: `@@ -L,N +L,N @@` over each hunk, a
 * side of one line as `L`, an empty side as the line before it and `,0`,
 * then the context lines with a space and the changes with `-` and `+`.
 */

import type { Hunk } from "./hunks.js";
import type { Lines } from "./lines.js";
import { type LineStyle, writeLine } from "./output.js";

function range(start: number, end: number): string {
  const count = end - start;
  if (count === 1) return `${start + 1}`;
  if (count === 0) return `${start},0`;
  return `${start + 1},${count}`;
}

export function formatUnified(
  a: Lines,
  b: Lines,
  hunks: Hunk[],
  style: LineStyle,
  out: string[],
  heading: (hunk: Hunk) => string = () => "",
): void {
  for (const hunk of hunks) {
    const title = heading(hunk);
    out.push(
      `@@ -${range(hunk.a0, hunk.a1)} +${range(hunk.b0, hunk.b1)} @@${title ? ` ${title}` : ""}\n`,
    );
    let i = hunk.a0;
    for (const change of hunk.changes) {
      for (; i < change.a0; i++) writeLine(out, " ", "", a, i, style);
      for (let x = change.a0; x < change.a1; x++) {
        writeLine(out, "-", "", a, x, style);
      }
      for (let y = change.b0; y < change.b1; y++) {
        writeLine(out, "+", "", b, y, style);
      }
      i = change.a1;
    }
    for (; i < hunk.a1; i++) writeLine(out, " ", "", a, i, style);
  }
}
