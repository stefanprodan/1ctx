/**
 * (1ctx) GNU diff's normal format: `LaR`, `FcT` and `RdL` over each change,
 * the first file's lines after `< `, `---`, the second's after `> `.
 */

import type { Hunk } from "./hunks.js";
import type { Lines } from "./lines.js";
import { type LineStyle, writeLine } from "./output.js";

function range(start: number, end: number): string {
  return end - start === 1 ? `${start + 1}` : `${start + 1},${end}`;
}

export function formatNormal(
  a: Lines,
  b: Lines,
  hunks: Hunk[],
  style: LineStyle,
  out: string[],
): void {
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const { a0, a1, b0, b1 } = change;
      if (a0 === a1) out.push(`${a0}a${range(b0, b1)}\n`);
      else if (b0 === b1) out.push(`${range(a0, a1)}d${b0}\n`);
      else out.push(`${range(a0, a1)}c${range(b0, b1)}\n`);
      for (let x = a0; x < a1; x++) writeLine(out, "<", " ", a, x, style);
      if (a0 !== a1 && b0 !== b1) out.push("---\n");
      for (let y = b0; y < b1; y++) writeLine(out, ">", " ", b, y, style);
    }
  }
}
