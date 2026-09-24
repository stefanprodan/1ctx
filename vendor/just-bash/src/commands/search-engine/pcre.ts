/**
 * (1ctx) grep -P's Perl syntax on RE2, which runs in linear time. What RE2
 * can express is rewritten: a leading lookbehind becomes a prefix the
 * reported match leaves out, as \K does, a trailing lookahead a suffix it
 * leaves out, and \h, \v, \R, \s, \w and the POSIX classes the Unicode sets
 * PCRE2 gives GNU grep 3.12 in a UTF-8 locale. What RE2 cannot run is
 * refused naming the construct, never emulated by backtracking.
 */

import { GnuPatternError } from "./gnu-regex.js";

const H =
  "\\t \\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}";
const V = "\\n\\x0b\\f\\r\\x{85}\\x{2028}\\x{2029}";

const categories = new Map<string, string>();

/**
 * A general category as code point ranges. RE2JS folds case with tables
 * that lack the caseless categories and throws on \p{N} under -i, so every
 * category but the letters and marks is spelled out, once per process.
 */
function category(name: string): string {
  if (/^[LM]/.test(name)) return `\\p{${name}}`;
  let ranges = categories.get(name);
  if (ranges !== undefined) return ranges;
  const re = new RegExp(`^\\p{${name}}$`, "u");
  const hex = (cp: number) => `\\x{${cp.toString(16)}}`;
  ranges = "";
  let start = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const inside = cp < 0x110000 && re.test(String.fromCodePoint(cp));
    if (inside && start < 0) start = cp;
    if (!inside && start >= 0) {
      ranges += start === cp - 1 ? hex(start) : `${hex(start)}-${hex(cp - 1)}`;
      start = -1;
    }
  }
  categories.set(name, ranges);
  return ranges;
}

/** JavaScript's names for the general categories, which RE2 shares. */
const GENERAL = /^(?:[LMNPSZC][a-z]?)$/;

interface Sets {
  space: string;
  word: string;
  escapes: Map<string, [string | null, string]>;
  posix: Map<string, string>;
}

let built: Sets | undefined;

function sets(): Sets {
  if (built) return built;
  const space = `${H}${V}${category("Z")}`;
  const word = `\\p{L}${category("N")}\\p{Mn}${category("Pc")}`;
  built = {
    space,
    word,
    // an escape's rewrite inside a class (null keeps it) and outside one
    escapes: new Map<string, [string | null, string]>([
      ["h", [H, `[${H}]`]],
      ["H", [null, `[^${H}]`]],
      ["v", [V, `[${V}]`]],
      ["V", [null, `[^${V}]`]],
      ["s", [space, `[${space}]`]],
      ["S", [null, `[^${space}]`]],
      ["w", [word, `[${word}]`]],
      ["W", [null, `[^${word}]`]],
      ["R", [null, `(?:\\r\\n|[${V}])`]],
      // a line holds no newline, so the end before a final one is the end
      ["Z", [null, "\\z"]],
    ]),
    posix: new Map<string, string>([
      ["alpha", "\\p{L}"],
      ["digit", category("Nd")],
      ["alnum", `\\p{L}${category("N")}`],
      ["lower", "\\p{Ll}"],
      ["upper", "\\p{Lu}"],
      ["xdigit", "0-9A-Fa-f"],
      ["space", space],
      ["blank", H],
      ["punct", `${category("P")}$+<=>^\`|~`],
      ["graph", "!-~"],
      ["print", " -~"],
      ["cntrl", category("Cc")],
      ["ascii", "\\x00-\\x7F"],
      ["word", word],
    ]),
  };
  return built;
}

function unsupported(construct: string, missing: string): never {
  throw new GnuPatternError(
    `${construct} is not supported: the regex engine is RE2, which has no ${missing}`,
  );
}

const QUANTIFIER = /^\{(?:\d+(?:,\d*)?|,\d+)\}/;
const RECURSION = /^\(\?(?:R|[+-]?\d+|&|P>)/;

/** Rewrites escapes, classes and groups, refusing what RE2 cannot run. */
function rewrite(pattern: string): string {
  let out = "";
  let inClass = false;
  let quantified = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[++i] ?? "";
      const after = pattern[i + 1] ?? "";
      if (!inClass) {
        if (next >= "1" && next <= "9") {
          unsupported(`backreference \\${next}`, "backreferences");
        }
        if (next === "g" && /[0-9{<'+-]/.test(after)) {
          unsupported("backreference \\g", "backreferences");
        }
        if (next === "k" && /[<{']/.test(after)) {
          unsupported("backreference \\k", "backreferences");
        }
      }
      // a stray \E ends no quote, as in Perl
      if (next === "E" && !inClass) continue;
      if (next === "p" || next === "P") {
        const m = /^(?:\{\^?([A-Za-z]+)\}|([A-Za-z]))/.exec(
          pattern.slice(i + 1),
        );
        const name = m ? (m[1] ?? m[2]) : "";
        const negated = next === "P" || (m?.[0].startsWith("{^") ?? false);
        if (m && GENERAL.test(name) && !/^[LM]/.test(name)) {
          const ranges = category(name);
          if (!inClass) {
            out += `[${negated ? "^" : ""}${ranges}]`;
            i += m[0].length;
            quantified = false;
            continue;
          }
          if (!negated) {
            out += ranges;
            i += m[0].length;
            continue;
          }
        }
      }
      const sub = sets().escapes.get(next);
      out += sub ? ((inClass ? sub[0] : sub[1]) ?? `\\${next}`) : `\\${next}`;
      quantified = false;
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
        out += ch;
      } else if (ch === "[" && pattern[i + 1] === ":") {
        const close = pattern.indexOf(":]", i + 2);
        const name = close === -1 ? "" : pattern.slice(i + 2, close);
        const set = sets().posix.get(name);
        if (set === undefined) {
          if (close !== -1) {
            throw new GnuPatternError(`unknown POSIX class name ${name}`);
          }
          out += "\\[";
        } else {
          out += set;
          i = close + 1;
        }
      } else {
        out += ch === "[" ? "\\[" : ch;
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      quantified = false;
      out += ch;
      if (pattern[i + 1] === "^") out += pattern[++i];
      if (pattern[i + 1] === "]") {
        out += "\\]";
        i++;
      }
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?") {
      if (ch === "+" && quantified) {
        unsupported("a possessive quantifier", "possessive quantifiers");
      }
      // a ? after a quantifier makes it lazy, which RE2 has
      quantified = !(ch === "?" && quantified);
      out += ch;
      continue;
    }
    if (ch === "{") {
      const m = QUANTIFIER.exec(pattern.slice(i));
      if (m) {
        out += m[0].startsWith("{,") ? `{0${m[0].slice(1)}` : m[0];
        i += m[0].length - 1;
        quantified = true;
        continue;
      }
    }
    quantified = false;
    if (ch === "(" && pattern[i + 1] === "*") {
      unsupported("a backtracking verb (*", "backtracking verbs");
    }
    if (ch === "(" && pattern[i + 1] === "?") {
      const rest = pattern.slice(i);
      if (rest.startsWith("(?#")) {
        const close = pattern.indexOf(")", i);
        if (close === -1) {
          throw new GnuPatternError("missing ) after (?# comment");
        }
        i = close;
        continue;
      }
      if (rest.startsWith("(?>")) {
        unsupported("an atomic group (?>", "atomic groups");
      }
      if (rest.startsWith("(?P=")) {
        unsupported("backreference (?P=", "backreferences");
      }
      if (RECURSION.test(rest)) unsupported("recursion", "recursion");
      if (rest.startsWith("(?(")) {
        unsupported("a conditional group (?(", "conditional groups");
      }
      if (rest.startsWith("(?|")) {
        unsupported("a branch reset group (?|", "branch reset groups");
      }
      if (rest.startsWith("(?P<")) {
        out += "(?<";
        i += 3;
        continue;
      }
      const quoted = /^\(\?'([A-Za-z_]\w*)'/.exec(rest);
      if (quoted) {
        out += `(?<${quoted[1]}>`;
        i += quoted[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Walks a rewritten pattern outside classes, with the group depth. */
function* tokens(pattern: string): Generator<{ at: number; depth: number }> {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (inClass) {
      if (ch === "\\") i++;
      else if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      if (pattern[i + 1] === "^") i++;
      continue;
    }
    if (ch === ")") depth--;
    yield { at: i, depth };
    if (ch === "(") depth++;
    if (ch === "\\") i++;
  }
}

/** The index of the `)` closing the group opened at `start`, or -1. */
function closingParen(pattern: string, start: number): number {
  let level = -1;
  for (const { at, depth } of tokens(pattern)) {
    if (at === start) level = depth;
    else if (at > start && depth === level && pattern[at] === ")") return at;
  }
  return -1;
}

function lookaround(pattern: string): string | null {
  for (const { at } of tokens(pattern)) {
    if (pattern.startsWith("(?!", at)) {
      unsupported("negative lookahead (?!", "lookaround");
    }
    if (pattern.startsWith("(?<!", at)) {
      unsupported("negative lookbehind (?<!", "lookaround");
    }
    if (pattern.startsWith("(?<=", at)) return "lookbehind (?<=";
    if (pattern.startsWith("(?=", at)) return "lookahead (?=";
  }
  return null;
}

function countGroups(pattern: string): number {
  let count = 0;
  for (const { at } of tokens(pattern)) {
    if (pattern[at] !== "(") continue;
    if (pattern[at + 1] !== "?" || /^\(\?<[A-Za-z_]/.test(pattern.slice(at))) {
      count++;
    }
  }
  return count;
}

const OPENER = /^\((?:\?(?:<[A-Za-z_]\w*>|[a-zA-Z]*(?:-[a-zA-Z]*)?:))?/;

/**
 * A \K inside groups is moved out of them: the groups close before it and
 * open again, uncaptured, after it. That holds only when no group around
 * it repeats or has alternatives, which would tie the two halves.
 */
function liftKeep(body: string): string {
  const openers: number[] = [];
  let at = -1;
  let count = 0;
  for (const token of tokens(body)) {
    const ch = body[token.at];
    if (ch === "(") openers.push(token.at);
    else if (ch === ")") openers.pop();
    else if (body.startsWith("\\K", token.at)) {
      count++;
      if (openers.length > 0) at = token.at;
    }
  }
  if (at === -1) return body;
  const refuse = (why: string): never => {
    throw new GnuPatternError(`\\K is supported inside a group only ${why}`);
  };
  if (count > 1) refuse("when it is the only \\K");
  const around: number[] = [];
  for (const token of tokens(body)) {
    if (token.at >= at) break;
    if (body[token.at] === "(") around.push(token.at);
    else if (body[token.at] === ")") around.pop();
  }
  let reopen = "";
  for (const open of around) {
    const close = closingParen(body, open);
    if (/^[*+?{]/.test(body.slice(close + 1))) {
      refuse("when no group around it repeats");
    }
    const depth = around.indexOf(open) + 1;
    for (const token of tokens(body.slice(0, close))) {
      if (token.at > open && token.depth === depth && body[token.at] === "|") {
        refuse("when no group around it has alternatives");
      }
    }
    const opener = OPENER.exec(body.slice(open))?.[0] ?? "(";
    reopen += opener.endsWith(":") ? opener : "(?:";
  }
  const closed = `${body.slice(0, at)}${")".repeat(around.length)}`;
  return `${closed}\\K${reopen}${body.slice(at + 2)}`;
}

export interface PcreTranslation {
  source: string;
  /** the group holding the reported match when part of it is left out */
  keepGroup?: number;
  /** the -x anchors are in place, around the kept part */
  anchored?: boolean;
  /** leading lookaheads, anchored: what the line must match, or must not */
  conditions?: Condition[];
}

export interface Condition {
  source: string;
  negated: boolean;
}

/**
 * The idioms ^(?=.*a)(?=.*b) and ^(?=.*a)(?!.*b) ask for a line holding
 * both, or one without the other: lookaheads at the line's start are
 * separate patterns it must match there, or must not. Without the ^ that
 * holds only for (?= with .*, where the line's start is the first start.
 */
function leadingLookaheads(body: string): [Condition[], string] | null {
  const anchor = body.startsWith("^") ? "^" : "";
  let rest = body.slice(anchor.length);
  const conditions: Condition[] = [];
  while (rest.startsWith("(?=") || rest.startsWith("(?!")) {
    const close = closingParen(rest, 0);
    if (close === -1) break;
    const negated = rest[2] === "!";
    conditions.push({ source: rest.slice(3, close), negated });
    rest = rest.slice(close + 1);
  }
  if (conditions.length === 0) return null;
  const free = (part: string) => part.startsWith(".*");
  const unanchored =
    conditions.every((c) => !c.negated && free(c.source)) &&
    (rest === "" || free(rest));
  if (anchor === "" && !unanchored) return null;
  return [conditions, `^${rest}`];
}

/** Translate a grep -P pattern, after \Q...\E, \x{...} and (?x) are done. */
export function translatePcre(
  pattern: string,
  lineRegexp = false,
): PcreTranslation {
  const s = rewrite(pattern);
  // leading flags apply to the whole pattern, a lookbehind after them too
  const flags = /^(?:\(\?[a-zA-Z]*(?:-[a-zA-Z]*)?\))*/.exec(s)?.[0] ?? "";
  let body = s.slice(flags.length);
  let behind = "";
  let ahead = "";
  let conditions: Condition[] = [];
  const leading = leadingLookaheads(body);
  if (leading !== null) [conditions, body] = leading;
  for (const { source } of conditions) {
    if (lookaround(source) !== null || source.includes("\\K")) {
      throw new GnuPatternError(
        "a leading lookahead (?= may hold no lookaround and no \\K",
      );
    }
  }
  if (body.startsWith("(?<=")) {
    const close = closingParen(body, 0);
    if (close !== -1) {
      behind = body.slice(4, close);
      body = body.slice(close + 1);
    }
  }
  if (body.endsWith(")")) {
    for (const { at, depth } of tokens(body)) {
      if (depth !== 0 || !body.startsWith("(?=", at)) continue;
      if (closingParen(body, at) === body.length - 1) {
        ahead = body.slice(at + 3, -1);
        body = body.slice(0, at);
      }
      break;
    }
  }
  const stray = lookaround(behind) ?? lookaround(body) ?? lookaround(ahead);
  if (stray !== null) {
    throw new GnuPatternError(
      stray.startsWith("lookbehind")
        ? "lookbehind (?<= is supported only at the start of the pattern"
        : "lookahead (?= is supported only at the end of the pattern or right after a leading ^",
    );
  }
  body = liftKeep(body);
  const keeps: number[] = [];
  let alternation = false;
  for (const { at, depth } of tokens(body)) {
    if (body.startsWith("\\K", at)) keeps.push(at);
    else if (body[at] === "|" && depth === 0) alternation = true;
  }
  for (const part of [behind, ahead]) {
    for (const { at } of tokens(part)) {
      if (part.startsWith("\\K", at)) {
        throw new GnuPatternError("\\K is not allowed in lookarounds");
      }
    }
  }
  const keep = keeps.at(-1) ?? -1;
  const extra =
    conditions.length > 0
      ? {
          conditions: conditions.map((c) => ({
            source: `${flags}^(?:${c.source})`,
            negated: c.negated,
          })),
        }
      : {};
  if (behind === "" && ahead === "" && keep === -1) {
    return { source: conditions.length > 0 ? `${flags}${body}` : s, ...extra };
  }
  if (alternation) {
    throw new GnuPatternError(
      "lookaround and \\K are supported only beside a pattern without a top-level |: put the alternatives in a group",
    );
  }
  // only the last \K counts, as in Perl
  let pre = "";
  let from = 0;
  for (const at of keeps) {
    pre += body.slice(from, at);
    from = at + 2;
  }
  const kept = keep === -1 ? body : body.slice(keep + 2);
  const before = behind ? `(?:${behind})` : "";
  const after = ahead ? `(?:${ahead})` : "";
  const keepGroup = countGroups(flags + behind + pre) + 1;
  if (lineRegexp) {
    // a lookbehind at the line's start and a lookahead at its end see
    // nothing, so each must match empty there, as in GNU's ^(?:...)$
    return {
      source: `${flags}${before}^(?:${pre})(${kept})$${after}`,
      keepGroup,
      anchored: true,
      ...extra,
    };
  }
  return {
    source: `${flags}(?:${before}${pre})(${kept})${after}`,
    keepGroup,
    ...extra,
  };
}
