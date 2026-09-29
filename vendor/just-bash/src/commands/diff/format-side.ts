/**
 * (1ctx) GNU diff's side by side format (-y): each line of the first file
 * in the left column and of the second in the right, cut at half the
 * width, with GNU's column arithmetic for -W, tabs and -t, and its marks:
 * `|` changed, `<` only on the left, `>` only on the right, `/` and `\`
 * for a changed pair where one side lacks its newline, `(` and `)` for
 * common lines --left-column or an ignored change leaves on one side.
 * Characters take the columns a terminal gives them; a byte that is not
 * UTF-8 takes one.
 */

import type { Change } from "./hunks.js";
import { columns, type Lines } from "./lines.js";

export interface SideStyle {
  /** -W, 130 when not given */
  width: number;
  /** -t */
  expandTabs: boolean;
  tabSize: number;
  leftColumn: boolean;
  suppressCommonLines: boolean;
  /** --sdiff-merge-assist: sdiff's commands before each run of lines */
  mergeAssist: boolean;
  /** takes the columns padded, which -W makes as many as asked */
  charge: (steps: number) => void;
}

/** The half width and the right column's offset, as GNU computes them. */
export function sideColumns(style: SideStyle): [number, number] {
  const t = style.expandTabs ? 1 : style.tabSize;
  // past 32 bits, where GNU's intmax_t still holds a width
  const w = Math.min(style.width, Number.MAX_SAFE_INTEGER);
  const tg = t + 3;
  const unaligned =
    Math.floor(w / 2) +
    Math.floor(tg / 2) +
    (w % 2 === 1 && tg % 2 === 1 ? 1 : 0);
  const off = unaligned - (unaligned % t);
  const half = Math.max(0, Math.min(off - 3, w - off));
  return [half, half ? off : w];
}

/** The UTF-8 character at `i` of a byte string: its columns and bytes. */
function scan(s: string, i: number): [number, number] {
  const b0 = s.charCodeAt(i);
  const len =
    b0 >= 0xf0 && b0 <= 0xf4 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc2 ? 2 : 0;
  if (len === 0 || i + len > s.length || b0 > 0xf4) return [1, 1];
  let cp = b0 & (0xff >> (len + 1));
  for (let k = 1; k < len; k++) {
    const b = s.charCodeAt(i + k);
    if (b < 0x80 || b > 0xbf) return [1, 1];
    cp = (cp << 6) | (b & 0x3f);
  }
  const min = [0, 0, 0x80, 0x800, 0x10000][len];
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return [1, 1];
  }
  // C1 controls print nothing
  const width = cp < 0xa0 ? -1 : columns(String.fromCodePoint(cp));
  return [width, len];
}

class Printer {
  private readonly half: number;
  private readonly offset: number;

  constructor(
    private readonly style: SideStyle,
    readonly out: string[],
  ) {
    [this.half, this.offset] = sideColumns(style);
  }

  private tabFromTo(from: number, to: number): number {
    if (to > from) this.style.charge(to - from);
    let at = from;
    if (!this.style.expandTabs) {
      const size = this.style.tabSize;
      for (let tab = at + size - (at % size); tab <= to; tab += size) {
        this.out.push("\t");
        at = tab;
      }
    }
    if (at < to) this.out.push(" ".repeat(to - at));
    return to;
  }

  /** Half a line cut at `bound` columns; returns the column it ends at. */
  private halfLine(line: string, indent: number, bound: number): number {
    const { out, style } = this;
    let inPos = 0;
    let outPos = 0;
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      const code = c.charCodeAt(0);
      if (c === "\t") {
        i++;
        let stop = inPos + style.tabSize - (inPos % style.tabSize);
        if (inPos === outPos) {
          if (style.expandTabs) {
            if (bound < stop) stop = bound;
            if (stop > outPos) {
              style.charge(stop - outPos);
              out.push(" ".repeat(stop - outPos));
              outPos = stop;
            }
          } else if (stop < bound) {
            outPos = stop;
            out.push(c);
          }
        }
        inPos = stop;
      } else if (c === "\r") {
        i++;
        out.push(c);
        this.tabFromTo(0, indent);
        inPos = 0;
        outPos = 0;
      } else if (c === "\b") {
        i++;
        if (inPos !== 0 && --inPos < bound) {
          if (outPos <= inPos) {
            if (outPos < inPos) {
              style.charge(inPos - outPos);
              out.push(" ".repeat(inPos - outPos));
            }
            outPos = inPos;
          } else {
            outPos = inPos;
            out.push(c);
          }
        }
      } else if (code >= 0x20 && code < 0x7f) {
        i++;
        inPos++;
        if (inPos <= bound) {
          outPos = inPos;
          out.push(c);
        }
      } else if (c === "\0" || c === "\x07" || c === "\f" || c === "\v") {
        i++;
        if (inPos <= bound) out.push(c);
      } else {
        const [width, len] = code < 0x80 ? [-1, 1] : scan(line, i);
        if (width > 0) inPos += width;
        if (inPos <= bound) {
          outPos = inPos;
          out.push(line.slice(i, i + len));
        }
        i += len;
      }
    }
    return outPos;
  }

  line(a: Lines | null, i: number, sep: string, b: Lines | null, j: number) {
    const complete = (file: Lines, k: number) =>
      k < file.lines.length - 1 || !file.incomplete;
    let col = 0;
    let newline = false;
    let mark = sep;
    if (a) {
      newline = complete(a, i);
      col = this.halfLine(a.lines[i], 0, this.half);
    }
    if (mark !== " ") {
      col =
        this.tabFromTo(col, Math.floor((this.half + this.offset - 1) / 2)) + 1;
      if (mark === "|" && b && newline !== complete(b, j)) {
        mark = newline ? "/" : "\\";
      }
      this.out.push(mark);
    }
    if (b) {
      newline ||= complete(b, j);
      if (b.lines[j] !== "") {
        col = this.tabFromTo(col, this.offset);
        this.halfLine(b.lines[j], col, this.half);
      }
    }
    if (newline) this.out.push("\n");
  }
}

export function formatSide(
  a: Lines,
  b: Lines,
  changes: Change[],
  style: SideStyle,
  out: string[],
): void {
  const p = new Printer(style, out);
  let next0 = 0;
  let next1 = 0;
  const common = (limit0: number, limit1: number) => {
    let i = next0;
    let j = next1;
    if (!style.suppressCommonLines && (i !== limit0 || j !== limit1)) {
      if (style.mergeAssist) p.out.push(`i${limit0 - i},${limit1 - j}\n`);
      if (!style.leftColumn) {
        while (i < limit0 && j < limit1) p.line(a, i++, " ", b, j++);
        while (j < limit1) p.line(null, 0, ")", b, j++);
      }
      while (i < limit0) p.line(a, i++, "(", null, 0);
    }
    next0 = limit0;
    next1 = limit1;
  };
  for (const { a0, a1, b0, b1 } of changes) {
    common(a0, b0);
    if (style.mergeAssist) p.out.push(`c${a1 - a0},${b1 - b0}\n`);
    let i = a0;
    let j = b0;
    for (; i < a1 && j < b1; i++, j++) p.line(a, i, "|", b, j);
    for (; j < b1; j++) p.line(null, 0, ">", b, j);
    for (; i < a1; i++) p.line(a, i, "<", null, 0);
    next0 = a1;
    next1 = b1;
  }
  common(a.lines.length, b.lines.length);
}
