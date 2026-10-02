/**
 * (1ctx awk) How awk's match, sub, gsub, gensub, split, FS and RS match.
 * POSIX awk takes the leftmost-longest match, so match("foobar",
 * /foo|foobar/) is 6 long. gawk 5.4's MinRX also reads POSIX 2024's
 * shortest-match operators (*?, +?, ??, {n,m}?), which RE2 honours only
 * in its leftmost-first mode, so a pattern with one matches that way.
 */

import { createUserRegex, type UserRegex } from "../../regex/index.js";

const INTERVAL = /^\{\d+(,\d*)?\}/;

/** Whether a quantifier in the pattern is followed by `?`. */
export function hasShortestMatch(pattern: string): boolean {
  let afterQuantifier = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "?" && afterQuantifier) return true;
    if (ch === "\\") {
      afterQuantifier = false;
      i += 2;
      continue;
    }
    if (ch === "[") {
      afterQuantifier = false;
      i = bracketEnd(pattern, i);
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?") {
      afterQuantifier = true;
      i++;
      continue;
    }
    const interval = ch === "{" ? INTERVAL.exec(pattern.slice(i)) : null;
    if (interval) {
      afterQuantifier = true;
      i += interval[0].length;
      continue;
    }
    afterQuantifier = false;
    i++;
  }
  return false;
}

// The index past the bracket expression opening at `start`: a leading `]`
// is literal, and `[:alpha:]`, `[=a=]`, `[.a.]` and escapes are skipped.
function bracketEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "^") i++;
  if (pattern[i] === "]") i++;
  while (i < pattern.length && pattern[i] !== "]") {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    const kind = pattern[i + 1];
    if (pattern[i] === "[" && (kind === ":" || kind === "=" || kind === ".")) {
      const close = pattern.indexOf(`${kind}]`, i + 2);
      if (close !== -1) {
        i = close + 2;
        continue;
      }
    }
    i++;
  }
  return i + 1;
}

/** A regex for awk's matching functions and separators. */
export function awkRegex(pattern: string, flags = ""): UserRegex {
  return createUserRegex(pattern, flags, {
    longest: !hasShortestMatch(pattern),
  });
}
