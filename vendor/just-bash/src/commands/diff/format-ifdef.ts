/**
 * (1ctx) GNU diff's merged output: -D NAME and the line and group formats.
 * The files are walked as groups of lines, unchanged, old, new or
 * changed, each printed by its group format, whose `%<`, `%>` and `%=`
 * print the group's lines by their line format. Every directive of GNU's
 * help is here: `%%`, `%c'C'`, `%c'\OOO'`, printf specs of a line number
 * (`%dn`) or of a group's first, last, count, before and after (`%dF`,
 * `%dl`, ...), and `%(A=B?T:E)`. A directive GNU cannot read prints as it
 * is. Formats and lines are bytes, one character a byte.
 */

import type { Change } from "./hunks.js";
import { expandTabs, type Lines } from "./lines.js";
import { CHANGED, NEW, OLD, UNCHANGED } from "./options.js";

interface Group {
  file: Lines;
  /** lines from to upto, 0-based */
  from: number;
  upto: number;
}

interface Ifdef {
  /** line formats by UNCHANGED, OLD and NEW, as bytes */
  lines: string[];
  /** -t: tabs expanded at this size, 0 to keep them */
  tabSize: number;
}

const isDigit = (c: string) => c >= "0" && c <= "9";

/** A group's number for a letter, the new group's for a capital, else -1. */
function letterValue(groups: [Group, Group], letter: string): number {
  const g = letter >= "A" && letter <= "Z" ? groups[1] : groups[0];
  switch (letter.toLowerCase()) {
    case "e":
      return g.from;
    case "f":
      return g.from + 1;
    case "l":
      return g.upto;
    case "m":
      return g.upto + 1;
    case "n":
      return g.upto - g.from;
    default:
      return -1;
  }
}

/** A character literal after `%c'`: its byte and where it ends, or null. */
function charLiteral(f: string, at: number): [string, number] | null {
  let p = at;
  const c = f[p++] ?? "";
  if (c === "" || c === "'") return null;
  if (c !== "\\") {
    if (f[p++] !== "'") return null;
    return [c, p];
  }
  let value = 0;
  for (;;) {
    const d = f[p++] ?? "";
    if (d === "'") break;
    if (!(d >= "0" && d <= "7")) return null;
    value = value * 8 + Number(d);
  }
  const digits = p - at - 2;
  if (digits < 1 || digits > 3) return null;
  return [String.fromCharCode(value & 0xff), p];
}

/** printf's %d, %o, %x or %X of a non-negative count with its flags. */
function printf(
  flags: string,
  width: number,
  precision: number | null,
  conv: string,
  value: number,
): string {
  const negative = value < 0;
  let digits = Math.abs(value).toString(
    conv === "o" ? 8 : conv === "d" ? 10 : 16,
  );
  if (conv === "X") digits = digits.toUpperCase();
  if (flags.includes("'") && conv === "d") {
    digits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  if (precision !== null) {
    if (precision === 0 && value === 0) digits = "";
    digits = digits.padStart(precision, "0");
  }
  const sign = negative ? "-" : "";
  const len = sign.length + digits.length;
  if (len >= width) return sign + digits;
  if (flags.includes("-")) return (sign + digits).padEnd(width, " ");
  if (flags.includes("0") && precision === null) {
    return sign + digits.padStart(width - sign.length, "0");
  }
  return (sign + digits).padStart(width, " ");
}

/**
 * A printf directive at `f[at]` (a `%`): its text and where it ends, or
 * null when GNU cannot read it. A line directive takes `n`, the line's
 * number; a group directive a group letter.
 */
function printfSpec(
  f: string,
  at: number,
  line: number | null,
  groups: [Group, Group] | null,
): [string, number] | null {
  let p = at + 1;
  let flags = "";
  let c = f[p++] ?? "";
  while (c === "-" || c === "'" || c === "0") {
    flags += c;
    c = f[p++] ?? "";
  }
  let width = "";
  while (isDigit(c)) {
    width += c;
    c = f[p++] ?? "";
  }
  let precision: number | null = null;
  if (c === ".") {
    let digits = "";
    for (c = f[p++] ?? ""; isDigit(c); c = f[p++] ?? "") digits += c;
    precision = Number(digits || "0");
  }
  const c1 = f[p++] ?? "";
  if (c === "c") {
    if (c1 !== "'") return null;
    return charLiteral(f, p);
  }
  if (c !== "d" && c !== "o" && c !== "x" && c !== "X") return null;
  let value: number;
  if (line !== null) {
    if (c1 !== "n") return null;
    value = line + 1;
  } else {
    value = letterValue(groups as [Group, Group], c1);
    if (value < 0) return null;
  }
  return [printf(flags, Number(width || "0"), precision, c, value), p];
}

function lineBytes(
  run: Ifdef,
  file: Lines,
  i: number,
  newline: boolean,
): string {
  let line = file.lines[i];
  if (run.tabSize > 0) line = expandTabs(line, run.tabSize);
  const complete = i < file.lines.length - 1 || !file.incomplete;
  return newline && complete ? `${line}\n` : line;
}

function printLines(
  run: Ifdef,
  format: string,
  group: Group,
  out: string[] | null,
): void {
  if (out === null) return;
  for (let i = group.from; i < group.upto; i++) {
    let p = 0;
    while (p < format.length) {
      const c = format[p++];
      if (c !== "%") {
        out.push(c);
        continue;
      }
      const d = format[p] ?? "";
      if (d === "%") {
        out.push("%");
        p++;
      } else if (d === "l" || d === "L") {
        out.push(lineBytes(run, group.file, i, d === "L"));
        p++;
      } else {
        const spec = printfSpec(format, p - 1, i, null);
        if (spec === null) {
          out.push("%");
        } else {
          out.push(spec[0]);
          p = spec[1];
        }
      }
    }
  }
}

/**
 * Prints `format` from `at` up to the first free `end` (or its end) for the
 * pair of groups, nothing when `out` is null; returns where it stopped.
 */
function formatGroup(
  run: Ifdef,
  format: string,
  at: number,
  end: string,
  groups: [Group, Group],
  out: string[] | null,
): number {
  let f = at;
  while (f < format.length && format[f] !== end) {
    const c = format[f++];
    if (c !== "%") {
      out?.push(c);
      continue;
    }
    const f1 = f;
    const d = format[f++] ?? "";
    if (d === "%") {
      out?.push("%");
      continue;
    }
    if (d === "(") {
      const values: number[] = [];
      let bad = false;
      for (const sep of "=?") {
        let value: number;
        if (isDigit(format[f] ?? "")) {
          let digits = "";
          while (isDigit(format[f] ?? "")) digits += format[f++];
          value = Number(digits);
        } else {
          value = letterValue(groups, format[f] ?? "");
          if (value < 0) {
            bad = true;
            break;
          }
          f++;
        }
        if (format[f++] !== sep) {
          bad = true;
          break;
        }
        values.push(value);
      }
      if (!bad) {
        const equal = values[0] === values[1];
        f = formatGroup(run, format, f, ":", groups, equal ? out : null);
        if (f < format.length) {
          f = formatGroup(run, format, f + 1, ")", groups, equal ? null : out);
          if (f < format.length) f++;
        }
        continue;
      }
    } else if (d === "<") {
      printLines(run, run.lines[OLD], groups[0], out);
      continue;
    } else if (d === "=") {
      printLines(run, run.lines[UNCHANGED], groups[0], out);
      continue;
    } else if (d === ">") {
      printLines(run, run.lines[NEW], groups[1], out);
      continue;
    } else {
      const spec = printfSpec(format, f - 2, null, groups);
      if (spec !== null) {
        out?.push(spec[0]);
        f = spec[1];
        continue;
      }
    }
    // what GNU cannot read prints as it is
    out?.push("%");
    f = f1;
  }
  return f;
}

/**
 * Prints the files through the group formats (UNCHANGED, OLD, NEW,
 * CHANGED, as bytes). Returns whether GNU began output, which a pair in a
 * directory is named for.
 */
export function formatIfdef(
  a: Lines,
  b: Lines,
  changes: Change[],
  groupFormats: string[],
  run: Ifdef,
  out: string[],
): boolean {
  let began = false;
  let next0 = 0;
  let next1 = 0;
  const print = (
    format: string,
    a0: number,
    a1: number,
    b0: number,
    b1: number,
  ) => {
    began = true;
    formatGroup(
      run,
      format,
      0,
      "",
      [
        { file: a, from: a0, upto: a1 },
        { file: b, from: b0, upto: b1 },
      ],
      out,
    );
  };
  for (const { a0, a1, b0, b1 } of changes) {
    if (next0 < a0 || next1 < b0) {
      print(groupFormats[UNCHANGED], next0, a0, next1, b0);
    }
    next0 = a1;
    next1 = b1;
    const kind = a1 === a0 ? NEW : b1 === b0 ? OLD : CHANGED;
    print(groupFormats[kind], a0, a1, b0, b1);
  }
  if (next0 < a.lines.length || next1 < b.lines.length) {
    print(
      groupFormats[UNCHANGED],
      next0,
      a.lines.length,
      next1,
      b.lines.length,
    );
  }
  return began;
}
