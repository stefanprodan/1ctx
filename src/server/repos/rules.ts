// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository's ignore rules: .gitignore text with git's wildmatch,
// ported from git's dir.c and wildmatch.c so every answer is git's.
// Patterns and paths are matched as UTF-8 bytes, as git matches them.

import {
  DEFAULT_REPO_IGNORE as DEFAULT_IGNORE,
  MAX_REPO_IGNORE_BYTES as MAX_IGNORE_BYTES,
  MAX_REPO_IGNORE_LINES as MAX_IGNORE_LINES,
} from "../../shared/contracts/repo.ts";

export { DEFAULT_IGNORE };

export interface IgnorePattern {
  /** the pattern as bytes, without its `!`, leading `/` and trailing `/` */
  readonly text: string;
  readonly negated: boolean;
  readonly dirOnly: boolean;
  /** no slash: matched against the last name of a path, at any depth */
  readonly basename: boolean;
  /** no wildcard: an equality test */
  readonly literal: boolean;
  /** `*` and a literal: a suffix test */
  readonly endsWith: boolean;
  /** the literal text before the first wildcard */
  readonly head: string;
  /** the literal text after the last wildcard and slash: a double star
   * and its slash may match nothing */
  readonly tail: string;
  /** the longest run of plain characters, which the name must contain */
  readonly needle: string;
}

export interface IgnoreRules {
  readonly patterns: readonly IgnorePattern[];
  /** folders already answered, by their bytes: a tarball repeats them */
  readonly folders: Map<string, boolean>;
}

// past this many folders the memo starts over, so it stays small
const MAX_FOLDERS = 65_536;

export type ParsedIgnore =
  | { ok: true; rules: IgnoreRules }
  | { ok: false; line: number; reason: string };

/** The text in force: an empty one means the default list, a set one replaces it. */
export function effectiveIgnore(text: string): string {
  return text.trim() === "" ? `${DEFAULT_IGNORE.join("\n")}\n` : text;
}

/** A short stable name for the effective rules, for a cache folder. */
export function ignoreKey(text: string): string {
  const lines = effectiveIgnore(text)
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return new Bun.CryptoHasher("sha256")
    .update(lines.join("\n"))
    .digest("hex")
    .slice(0, 12);
}

const encoder = new TextEncoder();

// the bytes of a string, one char each, so `?` takes one byte as in git
function bytes(text: string): string {
  if (!/[^\p{ASCII}]/u.test(text)) return text;
  let out = "";
  for (const b of encoder.encode(text)) out += String.fromCharCode(b);
  return out;
}

/** Parses an ignore text, refusing a line git would never match. */
export function parseIgnore(text: string): ParsedIgnore {
  if (encoder.encode(text).length > MAX_IGNORE_BYTES) {
    return { ok: false, line: 0, reason: "longer than 8 KiB" };
  }
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > MAX_IGNORE_LINES) {
    return {
      ok: false,
      line: MAX_IGNORE_LINES + 1,
      reason: `more than ${MAX_IGNORE_LINES} lines`,
    };
  }
  const patterns: IgnorePattern[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line === "" || line.startsWith("#")) continue;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = trimTrailingSpaces(line);
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const pattern = bytes(line);
    const reason = checkPattern(pattern);
    if (reason) return { ok: false, line: i + 1, reason };
    const basename = !pattern.includes("/");
    const body = basename ? pattern : pattern.replace(/^\//, "");
    const head = body.slice(0, literalLength(body));
    patterns.push({
      text: body,
      negated,
      dirOnly,
      basename,
      literal: head === body,
      endsWith: /^\*[^*?[\\]*$/.test(body),
      head,
      tail: body.slice(body.search(/[^*?[\]\\/]*$/)),
      needle: longestRun(body),
    });
  }
  return { ok: true, rules: { patterns, folders: new Map() } };
}

// git's trim_trailing_spaces: spaces go unless the last is escaped
function trimTrailingSpaces(line: string): string {
  let lastSpace = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " ") {
      if (lastSpace < 0) lastSpace = i;
    } else if (c === "\\") {
      i++;
      if (i >= line.length) return line;
      lastSpace = -1;
    } else {
      lastSpace = -1;
    }
  }
  return lastSpace < 0 ? line : line.slice(0, lastSpace);
}

function literalLength(pattern: string): number {
  const at = pattern.search(/[*?[\\]/);
  return at < 0 ? pattern.length : at;
}

// a run never spans a slash, since a double star's slash may match nothing
function longestRun(p: string): string {
  let best = "";
  let from = 0;
  for (let i = 0; i <= p.length; i++) {
    const c = p[i];
    if (
      c === undefined ||
      c === "*" ||
      c === "?" ||
      c === "/" ||
      c === "\\" ||
      c === "["
    ) {
      if (i - from > best.length) best = p.slice(from, i);
      if (c === "\\") i++;
      else if (c === "[") i = classEnd(p, i) as number;
      from = i + 1;
    }
  }
  return best;
}

// a line git never matches, or with more ** runs than wildmatch backtracks fast
function checkPattern(p: string): string | null {
  const stars = p.replace(/\\[\s\S]/g, "").match(/\*\*/g)?.length ?? 0;
  if (stars > 8) return "more than 8 **";
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "\\") {
      if (++i >= p.length) return "ends in a backslash";
    } else if (p[i] === "[") {
      const end = classEnd(p, i);
      if (typeof end === "string") return end;
      i = end;
    }
  }
  return null;
}

// the index of a class's closing `]`, walked as dowild walks it
function classEnd(p: string, open: number): number | string {
  let i = open + 1;
  if (p[i] === "!" || p[i] === "^") i++;
  let prev = "";
  let c = p[i];
  do {
    if (c === undefined) return "unclosed [";
    if (c === "\\") {
      c = p[++i];
      if (c === undefined) return "unclosed [";
    } else if (c === "-" && prev && p[i + 1] && p[i + 1] !== "]") {
      c = p[++i];
      if (c === "\\") {
        c = p[++i];
        if (c === undefined) return "unclosed [";
      }
      c = "";
    } else if (c === "[" && p[i + 1] === ":") {
      const s = i + 2;
      let j = s;
      while (j < p.length && p[j] !== "]") j++;
      if (j >= p.length) return "unclosed [";
      if (j - s - 1 < 0 || p[j - 1] !== ":") {
        // no `:]`: the `[` is a member and the walk goes on after it
        c = "[";
      } else {
        const name = p.slice(s, j - 1);
        if (!Object.hasOwn(CLASS_TESTS, name))
          return `unknown class [:${name}:]`;
        i = j;
        c = "";
      }
    }
    prev = c;
    c = p[++i];
  } while (c !== "]");
  return i;
}

/**
 * Whether git ignores a clean relative path: a folder on the way that is
 * ignored hides everything under it, past any negation, then the last
 * pattern matching the path itself decides.
 */
export function ignored(
  rules: IgnoreRules,
  path: string,
  isDir: boolean,
): boolean {
  if (rules.patterns.length === 0) return false;
  const name = bytes(path);
  const slash = name.lastIndexOf("/");
  if (slash > 0 && folderIgnored(rules, name.slice(0, slash))) return true;
  const hit = lastMatch(rules.patterns, name, isDir);
  return hit !== null && !hit.negated;
}

// whether a folder or any folder above it is ignored, answered from the
// nearest folder already known down, in a loop since a path may be deep
function folderIgnored(rules: IgnoreRules, folder: string): boolean {
  const known = rules.folders.get(folder);
  if (known !== undefined) return known;
  const todo = [folder];
  let answer = false;
  for (
    let slash = folder.lastIndexOf("/");
    slash > 0;
    slash = folder.lastIndexOf("/", slash - 1)
  ) {
    const above = folder.slice(0, slash);
    const hit = rules.folders.get(above);
    if (hit !== undefined) {
      answer = hit;
      break;
    }
    todo.push(above);
  }
  for (let i = todo.length - 1; i >= 0; i--) {
    if (!answer) {
      const hit = lastMatch(rules.patterns, todo[i], true);
      answer = hit !== null && !hit.negated;
    }
    if (rules.folders.size >= MAX_FOLDERS) rules.folders.clear();
    rules.folders.set(todo[i], answer);
  }
  return answer;
}

function lastMatch(
  patterns: readonly IgnorePattern[],
  path: string,
  isDir: boolean,
): IgnorePattern | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  for (let i = patterns.length - 1; i >= 0; i--) {
    const pattern = patterns[i];
    if (pattern.dirOnly && !isDir) continue;
    if (
      pattern.basename
        ? matchBasename(pattern, base)
        : matchPathname(pattern, path)
    ) {
      return pattern;
    }
  }
  return null;
}

// the literal tail must end the name whatever the wildcards take
function matchBasename(pattern: IgnorePattern, base: string): boolean {
  if (pattern.literal) return pattern.text === base;
  if (!base.endsWith(pattern.tail)) return false;
  if (pattern.endsWith) return true;
  if (!base.includes(pattern.needle)) return false;
  return wildmatch(pattern.text, 0, base, 0, false, 0) === MATCH;
}

// git's match_pathname: the literal head is compared, then the rest is
// wildmatched, a `**` still judged by what precedes it in the whole pattern
function matchPathname(pattern: IgnorePattern, path: string): boolean {
  if (pattern.literal) return pattern.text === path;
  if (!path.startsWith(pattern.head) || !path.endsWith(pattern.tail)) {
    return false;
  }
  if (!path.includes(pattern.needle)) return false;
  const from = pattern.head.length;
  return wildmatch(pattern.text, from, path, from, true, 0) === MATCH;
}

const MATCH = 0;
const NOMATCH = 1;
const ABORT_ALL = -1;
const ABORT_TO_STARSTAR = -2;

const SLASH = 47;
const STAR = 42;
const BACKSLASH = 92;
const QUESTION = 63;
const OPEN = 91;
const CLOSE = 93;

const at = (s: string, i: number) => (i < s.length ? s.charCodeAt(i) : -1);

const isGlobSpecial = (c: number) =>
  c === STAR || c === QUESTION || c === OPEN || c === BACKSLASH;

// git's dowild, index for pointer; -1 stands for the C string's NUL
function wildmatch(
  p: string,
  pi: number,
  t: string,
  ti: number,
  pathname: boolean,
  start: number,
): number {
  for (; pi < p.length; ti++, pi++) {
    let pc = p.charCodeAt(pi);
    let tc = at(t, ti);
    if (tc === -1 && pc !== STAR) return ABORT_ALL;
    switch (pc) {
      case BACKSLASH:
        pc = at(p, ++pi);
        if (tc !== pc) return NOMATCH;
        break;
      case QUESTION:
        if (pathname && tc === SLASH) return NOMATCH;
        break;
      case STAR: {
        let matchSlash: boolean;
        if (at(p, ++pi) === STAR) {
          const prev = pi - 2;
          while (at(p, ++pi) === STAR) {}
          const next = at(p, pi);
          if (
            (prev < start || p.charCodeAt(prev) === SLASH) &&
            (next === -1 ||
              next === SLASH ||
              (next === BACKSLASH && at(p, pi + 1) === SLASH))
          ) {
            if (
              next === SLASH &&
              wildmatch(p, pi + 1, t, ti, pathname, pi + 1) === MATCH
            ) {
              return MATCH;
            }
            matchSlash = true;
          } else {
            matchSlash = !pathname;
          }
        } else {
          matchSlash = !pathname;
        }
        const next = at(p, pi);
        if (next === -1) {
          // a trailing `*` matches only when no slash is left
          if (!matchSlash && t.indexOf("/", ti) >= 0) return NOMATCH;
          return MATCH;
        }
        if (!matchSlash && next === SLASH) {
          const slash = t.indexOf("/", ti);
          if (slash < 0) return NOMATCH;
          ti = slash;
          break;
        }
        for (;;) {
          if (tc === -1) break;
          if (!isGlobSpecial(next)) {
            // the text before the literal belongs to the star
            for (;;) {
              tc = at(t, ti);
              if (tc === -1 || (!matchSlash && tc === SLASH)) break;
              if (tc === next) break;
              ti++;
            }
            if (tc !== next) return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR;
          }
          const matched = wildmatch(p, pi, t, ti, pathname, pi);
          if (matched !== NOMATCH) {
            if (!matchSlash || matched !== ABORT_TO_STARSTAR) return matched;
          } else if (!matchSlash && tc === SLASH) {
            return ABORT_TO_STARSTAR;
          }
          tc = at(t, ++ti);
        }
        return ABORT_ALL;
      }
      case OPEN: {
        pc = at(p, ++pi);
        const negated = pc === 33 || pc === 94;
        if (negated) pc = at(p, ++pi);
        let prev = 0;
        let matched = false;
        do {
          if (pc === -1) return ABORT_ALL;
          if (pc === BACKSLASH) {
            pc = at(p, ++pi);
            if (pc === -1) return ABORT_ALL;
            if (tc === pc) matched = true;
          } else if (
            pc === 45 &&
            prev &&
            at(p, pi + 1) !== -1 &&
            at(p, pi + 1) !== CLOSE
          ) {
            pc = at(p, ++pi);
            if (pc === BACKSLASH) {
              pc = at(p, ++pi);
              if (pc === -1) return ABORT_ALL;
            }
            if (tc <= pc && tc >= prev) matched = true;
            pc = 0;
          } else if (pc === OPEN && at(p, pi + 1) === 58) {
            const s = pi + 2;
            let j = s;
            while (j < p.length && p.charCodeAt(j) !== CLOSE) j++;
            if (j >= p.length) return ABORT_ALL;
            if (j - s - 1 < 0 || p.charCodeAt(j - 1) !== 58) {
              pi = s - 2;
              pc = OPEN;
              if (tc === pc) matched = true;
            } else {
              const name = p.slice(s, j - 1);
              if (!Object.hasOwn(CLASS_TESTS, name)) return ABORT_ALL;
              const test = CLASS_TESTS[name];
              if (test(tc)) matched = true;
              pi = j;
              pc = 0;
            }
          } else if (tc === pc) {
            matched = true;
          }
          prev = pc;
          pc = at(p, ++pi);
        } while (pc !== CLOSE);
        if (matched === negated || (pathname && tc === SLASH)) return NOMATCH;
        break;
      }
      default:
        if (tc !== pc) return NOMATCH;
    }
  }
  return ti < t.length ? NOMATCH : MATCH;
}

const between = (c: number, lo: number, hi: number) => c >= lo && c <= hi;
const isUpper = (c: number) => between(c, 65, 90);
const isLower = (c: number) => between(c, 97, 122);
const isDigit = (c: number) => between(c, 48, 57);
const isAlpha = (c: number) => isUpper(c) || isLower(c);
const isGraph = (c: number) => between(c, 33, 126);

// git's sane ctype: ASCII only, a byte past 127 is in no class
const CLASS_TESTS: Record<string, (c: number) => boolean> = {
  alnum: (c) => isAlpha(c) || isDigit(c),
  alpha: isAlpha,
  blank: (c) => c === 32 || c === 9,
  cntrl: (c) => between(c, 0, 31) || c === 127,
  digit: isDigit,
  graph: isGraph,
  lower: isLower,
  print: (c) => between(c, 32, 126),
  punct: (c) => isGraph(c) && !isAlpha(c) && !isDigit(c),
  space: (c) => c === 32 || between(c, 9, 13),
  upper: isUpper,
  xdigit: (c) => isDigit(c) || between(c, 65, 70) || between(c, 97, 102),
};
