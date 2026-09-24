/**
 * (1ctx) rg's own syntax, Rust's regex crate, on RE2: \w, \d and \s are
 * Unicode unless --no-unicode, and \< and \> (or \b{start} and \b{end})
 * are word edges. RE2's \b knows only ASCII, so an edge at the start or
 * the end of the pattern is checked in code, where it is exact, and one
 * anywhere else is RE2's \b.
 */

import { category, spaceSet } from "./unicode-sets.js";

export interface RustTranslation {
  source: string;
  /** the match starts a word: no word character before, one at its start */
  wordStart: boolean;
  /** the match ends a word: one word character before its end, none after */
  wordEnd: boolean;
}

let word: string | undefined;

/** Rust's \w: alphabetic, marks, decimal digits, connectors, joiners. */
function wordSet(): string {
  word ??= `\\p{L}\\p{M}${category("Nl")}${category("Nd")}${category("Pc")}\\x{200c}\\x{200d}`;
  return word;
}

const START = /^\\(?:<|b\{start\})/;
const END = /\\(?:>|b\{end\})$/;
const EDGE = /\\(?:<|>|b\{(?:start|end)(?:-half)?\})/y;

/** Whether the backslash ending at `at` is itself escaped. */
function escaped(pattern: string, at: number): boolean {
  let count = 0;
  for (let i = at - 1; i >= 0 && pattern[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

/** A `|` outside groups and classes. */
function topLevelAlternation(pattern: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
      if (pattern[i + 1] === "^") i++;
      if (pattern[i + 1] === "]") i++;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "|" && depth === 0) {
      return true;
    }
  }
  return false;
}

/** A class escape's Unicode set inside a class and outside one, if any. */
function unicodeClass(escape: string): [string, string] | null {
  const set =
    escape === "w" || escape === "W"
      ? wordSet()
      : escape === "d" || escape === "D"
        ? category("Nd")
        : escape === "s" || escape === "S"
          ? spaceSet()
          : null;
  if (set === null) return null;
  // a negated set inside a class stays RE2's own
  if (escape === escape.toUpperCase()) return [`\\${escape}`, `[^${set}]`];
  return [set, `[${set}]`];
}

function rewrite(pattern: string, unicode: boolean): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      EDGE.lastIndex = i;
      const edge = inClass ? null : EDGE.exec(pattern);
      if (edge) {
        out += "\\b";
        i += edge[0].length - 1;
        continue;
      }
      const next = pattern[i + 1] ?? "";
      const set = unicode ? unicodeClass(next) : null;
      out += set ? set[inClass ? 0 : 1] : `\\${next}`;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      if (pattern[i + 1] === "^") out += pattern[++i];
      if (pattern[i + 1] === "]") out += pattern[++i];
      continue;
    }
    out += ch;
  }
  return out;
}

/** Translate one rg pattern, after \Q...\E, \x{...} and (?x) are done. */
export function translateRust(
  pattern: string,
  unicode: boolean,
  single: boolean,
): RustTranslation {
  const flags = /^(?:\(\?[a-zA-Z]*(?:-[a-zA-Z]*)?\))*/.exec(pattern)?.[0] ?? "";
  let body = pattern.slice(flags.length);
  let wordStart = false;
  let wordEnd = false;
  if (single) {
    const start = START.exec(body);
    const end = END.exec(body);
    const trimmed = body.slice(
      start ? start[0].length : 0,
      end && !escaped(body, end.index) ? end.index : body.length,
    );
    if ((start || end) && !topLevelAlternation(trimmed)) {
      wordStart = start !== null;
      wordEnd = end !== null && !escaped(body, end.index);
      body = trimmed;
    }
  }
  return { source: flags + rewrite(body, unicode), wordStart, wordEnd };
}
