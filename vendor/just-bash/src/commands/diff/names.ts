/**
 * (1ctx) How GNU diff 3.12 orders and filters the names of two directories:
 * sorted by the locale's collation (byte order in the C locale), or
 * ignoring case under --ignore-file-name-case; -x and -X patterns matched
 * as fnmatch does without FNM_PATHNAME or FNM_PERIOD; and the words for a
 * file's type.
 */

import type { FsStat } from "../../fs/interface.js";

export type NameOrder = (a: string, b: string) => number;

/** Code point order, which is UTF-8's byte order. */
export function byteOrder(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function lowerFirst(ch: string): string {
  return String.fromCodePoint(ch.toLowerCase().codePointAt(0) as number);
}

/** Case ignored one character at a time, as mbscasecmp. */
export function caseOrder(a: string, b: string): number {
  return byteOrder(
    [...a].map(lowerFirst).join(""),
    [...b].map(lowerFirst).join(""),
  );
}

// ICU's root collation, as a UTF-8 locale's strcoll orders names where the
// fixture was recorded; C and POSIX compare bytes
const COLLATOR = new Intl.Collator("en-US");

/** Whether the environment's locale collates, as setlocale reads it. */
export function collates(env: {
  get(name: string): string | undefined;
}): boolean {
  const locale =
    env.get("LC_ALL") || env.get("LC_COLLATE") || env.get("LANG") || "";
  return !(
    locale === "" ||
    locale === "C" ||
    locale === "POSIX" ||
    locale.startsWith("C.")
  );
}

/** Names as GNU sorts a directory: collated, ties broken by bytes. */
export function nameOrder(ignoreCase: boolean, collate: boolean): NameOrder {
  if (ignoreCase) return caseOrder;
  if (!collate) return byteOrder;
  return (a, b) => COLLATOR.compare(a, b) || byteOrder(a, b);
}

const CLASSES: Record<string, RegExp> = {
  alnum: /[\p{L}\p{N}]/u,
  alpha: /\p{L}/u,
  blank: /[ \t]/,
  cntrl: /\p{Cc}/u,
  digit: /[0-9]/,
  graph: /[^\p{Z}\p{C}]/u,
  lower: /\p{Ll}/u,
  print: /[^\p{C}]/u,
  punct: /[!-/:-@[-`{-~]/,
  space: /\s/,
  upper: /\p{Lu}/u,
  xdigit: /[0-9A-Fa-f]/,
};

/**
 * Matches one bracket expression at `p[i]` (just past `[`) against `ch`:
 * the index past its `]` and whether it matched, or null when it has no
 * `]` and the `[` is an ordinary character.
 */
function bracket(
  p: string[],
  i: number,
  ch: string,
  fold: boolean,
): [number, boolean] | null {
  let j = i;
  const negate = p[j] === "!" || p[j] === "^";
  if (negate) j++;
  const c = fold ? ch.toLowerCase() : ch;
  let matched = false;
  let first = true;
  while (j < p.length && (first || p[j] !== "]")) {
    first = false;
    if (p[j] === "[" && p[j + 1] === ":") {
      const end = p.indexOf(":", j + 2);
      if (end !== -1 && p[end + 1] === "]") {
        const re = CLASSES[p.slice(j + 2, end).join("")];
        if (re?.test(ch)) matched = true;
        j = end + 2;
        continue;
      }
    }
    let lo = p[j];
    if (lo === "\\" && j + 1 < p.length) lo = p[++j];
    j++;
    let hi = lo;
    if (p[j] === "-" && j + 1 < p.length && p[j + 1] !== "]") {
      let k = j + 1;
      if (p[k] === "\\" && k + 1 < p.length) k++;
      hi = p[k];
      j = k + 1;
    }
    const [l, h] = fold ? [lo.toLowerCase(), hi.toLowerCase()] : [lo, hi];
    const code = c.codePointAt(0) as number;
    if (
      code >= (l.codePointAt(0) as number) &&
      code <= (h.codePointAt(0) as number)
    ) {
      matched = true;
    }
  }
  if (j >= p.length) return null;
  return [j + 1, matched !== negate];
}

/** fnmatch(3) with no flags but FNM_CASEFOLD when `fold`. */
export function fnmatch(pattern: string, name: string, fold: boolean): boolean {
  const p = [...pattern];
  const s = [...name];
  const same = (a: string, b: string) =>
    fold ? a.toLowerCase() === b.toLowerCase() : a === b;
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si < s.length) {
    if (pi < p.length) {
      const c = p[pi];
      if (c === "*") {
        starP = ++pi;
        starS = si;
        continue;
      }
      if (c === "?") {
        pi++;
        si++;
        continue;
      }
      if (c === "[") {
        const found = bracket(p, pi + 1, s[si], fold);
        if (found === null) {
          if (same("[", s[si])) {
            pi++;
            si++;
            continue;
          }
        } else if (found[1]) {
          pi = found[0];
          si++;
          continue;
        }
      } else {
        const lit = c === "\\" && pi + 1 < p.length ? p[pi + 1] : c;
        if (same(lit, s[si])) {
          pi += c === "\\" && pi + 1 < p.length ? 2 : 1;
          si++;
          continue;
        }
      }
    }
    if (starP === -1) return false;
    pi = starP;
    si = ++starS;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/** Whether -x or -X leaves a directory entry out. */
export function excluder(
  patterns: string[],
  fold: boolean,
): (name: string) => boolean {
  if (patterns.length === 0) return () => false;
  return (name) => patterns.some((p) => fnmatch(p, name, fold));
}

/** An exclude file's patterns: one a line, trailing blanks dropped. */
export function excludePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/[\t\n\v\f\r ]+$/, ""))
    .filter((line) => line !== "");
}

/** A file's type in GNU's words. */
export function fileType(stat: FsStat): string {
  if (stat.isSymbolicLink) return "symbolic link";
  if (stat.isDirectory) return "directory";
  if (stat.isFile)
    return stat.size === 0 ? "regular empty file" : "regular file";
  return "weird file";
}
