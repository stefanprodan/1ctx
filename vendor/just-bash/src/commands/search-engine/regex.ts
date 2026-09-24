/**
 * Regex building utilities for search commands
 */

import { createUserRegex, type UserRegex } from "../../regex/index.js";
import { GnuPatternError, translateGnu } from "./gnu-regex.js";
import { translatePcre } from "./pcre.js";

/** POSIX character class to JavaScript regex character range mapping (Map prevents prototype pollution) */
const POSIX_CLASS_MAP = new Map<string, string>([
  ["alpha", "a-zA-Z"],
  ["digit", "0-9"],
  ["alnum", "a-zA-Z0-9"],
  ["lower", "a-z"],
  ["upper", "A-Z"],
  ["xdigit", "0-9A-Fa-f"],
  ["space", " \\t\\n\\r\\f\\v"],
  ["blank", " \\t"],
  ["punct", "!-/:-@\\[-`{-~"],
  ["graph", "!-~"],
  ["print", " -~"],
  ["cntrl", "\\x00-\\x1F\\x7F"],
  ["ascii", "\\x00-\\x7F"],
  ["word", "a-zA-Z0-9_"],
]);

export type RegexMode = "basic" | "extended" | "fixed" | "perl";

export interface RegexOptions {
  mode: RegexMode;
  ignoreCase?: boolean;
  /**
   * (1ctx) Accepted for callers; the word check is the matcher's
   * (`SearchOptions.wholeWord`), since RE2's \b knows only ASCII
   */
  wholeWord?: boolean;
  lineRegexp?: boolean;
  multiline?: boolean;
  /** Makes . match newlines in multiline mode (ripgrep --multiline-dotall) */
  multilineDotall?: boolean;
  /** (1ctx) grep -P: PCRE2's syntax, rewritten to RE2 or refused */
  pcre?: boolean;
}

export interface RegexResult {
  regex: UserRegex;
  /** If \K was used, this is the 1-based index of the capture group containing the "real" match */
  kResetGroup?: number;
  /**
   * Optional fast-path filter: if every needle is absent from a line via
   * String.indexOf, the regex is guaranteed not to match and RE2 can be skipped.
   * Extracted only for patterns where it is provably safe (literal alternatives,
   * optionally wrapped in \b...\b for -w mode). Null for anything more complex.
   */
  preFilter?: PreFilter;
  /** (1ctx) GNU grep's warnings about the pattern, each once */
  warnings?: string[];
}

export interface PreFilter {
  /** Any one of these substrings must appear in a matching line (OR semantics). */
  needles: string[];
  /** When true, both needles and the line must be lowercased before indexOf. */
  ignoreCase: boolean;
}

/**
 * Transform POSIX character classes in bracket expressions to JavaScript regex equivalents.
 *
 * Examples:
 * - [[:alpha:]] → [a-zA-Z]
 * - [[:digit:]] → [0-9]
 * - [[:alpha:][:digit:]] → [a-zA-Z0-9]
 * - [^[:alpha:]] → [^a-zA-Z]
 * - [[:<:]] → (?<![\\w]) (word start boundary)
 * - [[:>:]] → (?![\\w]) (word end boundary)
 */
function transformPosixCharacterClasses(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    // Check for word boundary extensions [[:<:]] and [[:>:]]
    // Using \b instead of lookahead/lookbehind for RE2 compatibility
    if (pattern.slice(i, i + 7) === "[[:<:]]") {
      // Word start boundary - use \b (works at word/non-word boundary)
      result += "\\b";
      i += 7;
      continue;
    }
    if (pattern.slice(i, i + 7) === "[[:>:]]") {
      // Word end boundary - use \b (works at word/non-word boundary)
      result += "\\b";
      i += 7;
      continue;
    }

    // Check for start of bracket expression
    if (pattern[i] === "[") {
      // Parse the entire bracket expression
      let bracketExpr = "[";
      i++;

      // Handle negation
      if (i < pattern.length && (pattern[i] === "^" || pattern[i] === "!")) {
        bracketExpr += "^";
        i++;
      }

      // Handle ] as first char (literal ])
      if (i < pattern.length && pattern[i] === "]") {
        bracketExpr += "\\]";
        i++;
      }

      // Parse bracket expression contents
      while (i < pattern.length && pattern[i] !== "]") {
        // Check for POSIX character class [[:name:]]
        if (
          pattern[i] === "[" &&
          i + 1 < pattern.length &&
          pattern[i + 1] === ":"
        ) {
          // Find the closing :]
          const closeIdx = pattern.indexOf(":]", i + 2);
          if (closeIdx !== -1) {
            const className = pattern.slice(i + 2, closeIdx);
            const replacement = POSIX_CLASS_MAP.get(className);
            if (replacement) {
              bracketExpr += replacement;
              i = closeIdx + 2;
              continue;
            }
          }
        }

        // Handle escape sequences
        if (pattern[i] === "\\" && i + 1 < pattern.length) {
          bracketExpr += pattern[i] + pattern[i + 1];
          i += 2;
          continue;
        }

        // Regular character
        bracketExpr += pattern[i];
        i++;
      }

      // Close the bracket expression
      if (i < pattern.length && pattern[i] === "]") {
        bracketExpr += "]";
        i++;
      }

      result += bracketExpr;
      continue;
    }

    // Handle escape sequences outside bracket expressions
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      result += pattern[i] + pattern[i + 1];
      i += 2;
      continue;
    }

    // Regular character
    result += pattern[i];
    i++;
  }

  return result;
}

/**
 * Build a JavaScript RegExp from a pattern with the specified mode
 */
export function buildRegex(
  pattern: string,
  options: RegexOptions,
): RegexResult {
  return buildPatterns([pattern], options);
}

/**
 * (1ctx) Build one regex from several patterns, any of which selects a
 * line, as grep's -e and -f give them. `basic` and `extended` are GNU
 * grep's dialects, matched leftmost-longest as POSIX has it; `fixed` is
 * matched the same way; `perl` is leftmost-first.
 */
export function buildPatterns(
  patterns: string[],
  options: RegexOptions,
): RegexResult {
  const warnings: string[] = [];
  let kResetGroup: number | undefined;
  let anchored = false;
  const sources = patterns.map((pattern, index) => {
    if (options.pcre) {
      // (1ctx) quotes, code points and (?x) first, then PCRE2's syntax
      const source = handleInlineModifiers(
        handleUnicodeCodePoints(handleQuoteMetachars(pattern)),
      );
      let translated: ReturnType<typeof translatePcre>;
      try {
        translated = translatePcre(
          source,
          (options.lineRegexp ?? false) && patterns.length === 1,
        );
      } catch (error) {
        if (error instanceof GnuPatternError) error.index = index;
        throw error;
      }
      if (patterns.length === 1) {
        kResetGroup = translated.keepGroup;
        anchored = translated.anchored ?? false;
      }
      return translated.source;
    }
    switch (options.mode) {
      case "fixed":
        // Escape all regex special characters for literal match
        return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      case "basic":
      case "extended": {
        let translated: ReturnType<typeof translateGnu>;
        try {
          translated = translateGnu(pattern, options.mode);
        } catch (error) {
          if (error instanceof GnuPatternError) error.index = index;
          throw error;
        }
        for (const warning of translated.warnings) {
          if (!warnings.includes(warning)) warnings.push(warning);
        }
        return translated.source;
      }
      default: {
        // Transform POSIX character classes first
        let regexPattern = transformPosixCharacterClasses(pattern);

        // Convert (?P<name>...) to JavaScript's (?<name>...) syntax
        regexPattern = regexPattern.replace(/\(\?P<([^>]+)>/g, "(?<$1>");

        // Handle \Q...\E (quote metacharacters)
        regexPattern = handleQuoteMetachars(regexPattern);

        // Handle \x{NNNN} Unicode code points -> \u{NNNN}
        regexPattern = handleUnicodeCodePoints(regexPattern);

        // Handle inline modifiers (?i:...), (?i), etc.
        regexPattern = handleInlineModifiers(regexPattern);

        // Handle \K (Perl regex reset match start)
        const kResult = handlePerlKReset(regexPattern);
        if (patterns.length === 1) kResetGroup = kResult.kResetGroup;
        return kResult.pattern;
      }
    }
  });
  let regexPattern =
    sources.length === 1
      ? sources[0]
      : sources.map((source) => `(?:${source})`).join("|");

  if (options.wholeWord && options.multiline) {
    // (1ctx) a multiline search cannot check words in code
    regexPattern = `\\b(?:${regexPattern})\\b`;
  }
  if (options.lineRegexp && !anchored) {
    // Wrap in a non-capturing group so alternation binds inside the anchors:
    // a|b must become ^(?:a|b)$, not ^a|b$ (which anchors only the outer
    // alternatives). Matters for multi-pattern grep (-e/-f) with -x.
    regexPattern = `^(?:${regexPattern})$`;
  }

  // Build flags:
  // - g: global matching
  // - i: case insensitive
  // - m: multiline (^ and $ match at line boundaries)
  // - s: dotall (. matches newlines)
  // - u: unicode (needed for \u{NNNN} syntax)
  const needsUnicode = /\\u\{[0-9A-Fa-f]+\}/.test(regexPattern);
  const flags =
    "g" +
    (options.ignoreCase ? "i" : "") +
    (options.multiline ? "m" : "") +
    (options.multilineDotall ? "s" : "") +
    (needsUnicode ? "u" : "");
  const preFilter = extractPreFilter(regexPattern, options.ignoreCase ?? false);
  return {
    regex: createUserRegex(regexPattern, flags, {
      longest: options.mode !== "perl",
    }),
    kResetGroup,
    preFilter: preFilter ?? undefined,
    warnings,
  };
}

/**
 * Try to extract a set of literal substrings, at least one of which must
 * appear in any line that matches the pattern. Returns null when no safe
 * extraction is possible (e.g., the pattern uses quantifiers or character
 * classes that can match zero or arbitrary text).
 *
 * Recognised shapes (covers the bulk of grep usage):
 *   - bare literal:        "interface"   -> ["interface"]
 *   - escaped literal:     "Promise\\(" -> ["Promise("]
 *   - whole-word wrapper:  "\\b(?:type)\\b" or "\\btype\\b" -> ["type"]
 *   - alternation:         "interface|type" -> ["interface", "type"]
 *   - whole-word + alt:    "\\b(?:foo|bar)\\b" -> ["foo", "bar"]
 *
 * Anchors (^, $) and any quantifier or character class disable extraction.
 * False positives are fine (we just run the regex anyway); false negatives
 * would be bugs (skipping a line that the regex would match).
 */
function extractPreFilter(
  jsPattern: string,
  ignoreCase: boolean,
): PreFilter | null {
  let core = jsPattern;

  // Strip -w wrappers produced by buildRegex above.
  if (core.startsWith("\\b(?:") && core.endsWith(")\\b")) {
    core = core.slice("\\b(?:".length, core.length - ")\\b".length);
  } else if (
    core.startsWith("\\b") &&
    core.endsWith("\\b") &&
    core.length >= 4
  ) {
    core = core.slice(2, core.length - 2);
  }

  if (core.length === 0) return null;

  const alternatives = splitTopLevelAlternation(core);
  if (alternatives === null) return null;

  const needles: string[] = [];
  for (const alt of alternatives) {
    const literal = literalFromAlternative(alt);
    if (literal === null || literal.length === 0) return null;
    needles.push(literal);
  }

  if (needles.length === 0) return null;

  return {
    needles: ignoreCase ? needles.map((n) => n.toLowerCase()) : needles,
    ignoreCase,
  };
}

/**
 * Split a regex pattern on top-level | (alternation), respecting escapes,
 * grouping parens, and character classes. Returns null if structure is malformed.
 */
function splitTopLevelAlternation(pattern: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let last = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++; // skip the escaped char
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) return null;
    } else if (c === "|" && depth === 0) {
      parts.push(pattern.slice(last, i));
      last = i + 1;
    }
  }
  if (depth !== 0 || inClass) return null;
  parts.push(pattern.slice(last));
  return parts;
}

/**
 * Return the literal string represented by a regex alternative, or null if
 * the alternative contains any regex metacharacter that could match
 * something other than itself (quantifier, anchor, character class, group, dot).
 */
function literalFromAlternative(alt: string): string | null {
  // Strip a leading unescaped ^ anchor.
  let inner = alt;
  if (inner.startsWith("^")) {
    inner = inner.slice(1);
  }
  // Strip a trailing unescaped $ anchor. Walk back the run of trailing
  // backslashes: $ is an anchor iff that run has even length.
  if (inner.endsWith("$")) {
    let bs = 0;
    for (let i = inner.length - 2; i >= 0 && inner[i] === "\\"; i--) bs++;
    if (bs % 2 === 0) {
      inner = inner.slice(0, -1);
    }
  }
  // Anchor-only alternative — no useful needle.
  if (inner.length === 0) return null;

  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") {
      const next = inner[i + 1];
      if (next === undefined) return null;
      // Reject escapes that aren't simple literal substitutions.
      // \n, \t, \r are literal whitespace — fine. \d, \w, \s, \b, \B etc.
      // match character classes or zero-width assertions — reject.
      if (/[dDwWsSbBAZzGQE0-9ckpPNXRxuU]/.test(next)) return null;
      // Translate common escape sequences to their literal char.
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "f") out += "\f";
      else if (next === "v") out += "\v";
      else out += next; // \. \* \+ \? \^ \$ \( \) \[ \] \{ \} \| \\ \/ etc.
      i++;
      continue;
    }
    // Any unescaped regex metacharacter disqualifies the alternative.
    if (/[.*+?^${}()|[\]]/.test(c)) return null;
    out += c;
  }
  return out;
}

/**
 * Handle \Q...\E (quote metacharacters).
 * Everything between \Q and \E is treated as literal text.
 * If \E is missing, quotes until end of pattern.
 */
function handleQuoteMetachars(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    // Check for \Q
    if (
      pattern[i] === "\\" &&
      i + 1 < pattern.length &&
      pattern[i + 1] === "Q"
    ) {
      // Skip \Q
      i += 2;

      // Find matching \E or end of string
      let quoted = "";
      while (i < pattern.length) {
        if (
          pattern[i] === "\\" &&
          i + 1 < pattern.length &&
          pattern[i + 1] === "E"
        ) {
          // Found \E, skip it
          i += 2;
          break;
        }
        quoted += pattern[i];
        i++;
      }

      // Escape all regex metacharacters in the quoted section
      result += quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      result += pattern[i];
      i++;
    }
  }

  return result;
}

/**
 * Handle \x{NNNN} Unicode code points.
 * Converts Perl's \x{NNNN} to JavaScript's \u{NNNN}.
 */
function handleUnicodeCodePoints(pattern: string): string {
  // Convert \x{NNNN} to \u{NNNN}
  // The pattern matches \x{ followed by hex digits and }
  return pattern.replace(/\\x\{([0-9A-Fa-f]+)\}/g, "\\u{$1}");
}

/**
 * (1ctx) Inline flags reach RE2 as written: `(?i)`, `(?s)`, `(?m)`, `(?U)`
 * and their scoped and negated forms are RE2's own. `x` is not, so its
 * scope loses its whitespace and `#` comments here and the flag is dropped.
 */
function handleInlineModifiers(pattern: string): string {
  let out = "";
  let extended = false;
  const saved: boolean[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      out += extended && next === " " ? "\\x20" : ch + next;
      i += 2;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\") j++;
        else if (pattern[j] === "[" && pattern[j + 1] === ":") {
          const close = pattern.indexOf(":]", j + 2);
          if (close !== -1) j = close + 1;
        }
        j++;
      }
      out += pattern.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (extended && /\s/.test(ch)) {
      i++;
      continue;
    }
    if (extended && ch === "#") {
      while (i < pattern.length && pattern[i] !== "\n") i++;
      continue;
    }
    if (ch === "(") {
      const flags = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([):])/.exec(
        pattern.slice(i),
      );
      if (flags) {
        const on = flags[1];
        const off = flags[2] ?? "";
        const kept =
          on.replaceAll("x", "") +
          (off.replaceAll("x", "") ? `-${off.replaceAll("x", "")}` : "");
        if (flags[3] === ":") saved.push(extended);
        if (on.includes("x")) extended = true;
        if (off.includes("x")) extended = false;
        if (flags[3] === ":") out += `(?${kept}:`;
        else if (kept) out += `(?${kept})`;
        i += flags[0].length;
        continue;
      }
      saved.push(extended);
      out += ch;
      i++;
      continue;
    }
    if (ch === ")") {
      extended = saved.pop() ?? extended;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Handle Perl's \K (keep/reset match start) operator.
 * \K causes everything matched before it to be excluded from the final match result.
 *
 * We emulate this by:
 * 1. Wrapping the part before \K in a non-capturing group
 * 2. Wrapping the part after \K in a capturing group
 * 3. Returning the index of that capturing group so the matcher can use it
 */
function handlePerlKReset(pattern: string): {
  pattern: string;
  kResetGroup?: number;
} {
  // Find \K that's not escaped (not preceded by odd number of backslashes)
  // We need to find \K that represents the reset operator, not a literal \\K
  const kIndex = findUnescapedK(pattern);

  if (kIndex === -1) {
    return { pattern };
  }

  const before = pattern.slice(0, kIndex);
  const after = pattern.slice(kIndex + 2); // Skip \K

  // Count existing capturing groups before the split to determine our group number
  const groupsBefore = countCapturingGroups(before);

  // Wrap: (?:before)(after) - non-capturing for prefix, capturing for the part we want
  const newPattern = `(?:${before})(${after})`;

  return {
    pattern: newPattern,
    // The capturing group for "after" will be groupsBefore + 1
    kResetGroup: groupsBefore + 1,
  };
}

/**
 * Find the index of \K in a pattern, ignoring escaped backslashes
 */
function findUnescapedK(pattern: string): number {
  let i = 0;
  while (i < pattern.length - 1) {
    if (pattern[i] === "\\") {
      if (pattern[i + 1] === "K") {
        // Check if the backslash itself is escaped by counting preceding backslashes
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && pattern[j] === "\\") {
          backslashCount++;
          j--;
        }
        // If even number of preceding backslashes, this \K is not escaped
        if (backslashCount % 2 === 0) {
          return i;
        }
      }
      // Skip the escaped character
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Count the number of capturing groups in a regex pattern.
 * Excludes non-capturing groups (?:...), lookahead (?=...), (?!...),
 * lookbehind (?<=...), (?<!...), and named groups (?<name>...) which we count.
 */
function countCapturingGroups(pattern: string): number {
  let count = 0;
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      // Skip escaped character
      i += 2;
      continue;
    }

    if (pattern[i] === "[") {
      // Skip character class
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++; // Skip ]
      continue;
    }

    if (pattern[i] === "(") {
      if (i + 1 < pattern.length && pattern[i + 1] === "?") {
        // Check what kind of group
        if (i + 2 < pattern.length) {
          const nextChar = pattern[i + 2];
          if (nextChar === ":" || nextChar === "=" || nextChar === "!") {
            // Non-capturing or lookahead - don't count
            i++;
            continue;
          }
          if (nextChar === "<") {
            // Could be lookbehind (?<= or (?<! or named group (?<name>
            if (i + 3 < pattern.length) {
              const afterLt = pattern[i + 3];
              if (afterLt === "=" || afterLt === "!") {
                // Lookbehind - don't count
                i++;
                continue;
              }
              // Named group - count it
              count++;
              i++;
              continue;
            }
          }
        }
      } else {
        // Regular capturing group
        count++;
      }
    }
    i++;
  }

  return count;
}

/**
 * Convert replacement string syntax to JavaScript's String.replace format
 *
 * Conversions:
 * - $0 and ${0} -> $& (full match)
 * - $name -> $<name> (named capture groups)
 * - ${name} -> $<name> (braced named capture groups)
 * - Preserves $1, $2, etc. for numbered groups
 */
export function convertReplacement(replacement: string): string {
  // First, convert $0 and ${0} to $& (use $$& to produce literal $& in output)
  let result = replacement.replace(/\$\{0\}|\$0(?![0-9])/g, "$$&");

  // Convert ${name} to $<name> for non-numeric names
  result = result.replace(/\$\{([^0-9}][^}]*)\}/g, "$$<$1>");

  // Convert $name to $<name> for non-numeric names (not followed by > which would already be converted)
  // Match $name where name starts with letter or underscore and contains word chars
  result = result.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)(?![>0-9])/g, "$$<$1>");

  return result;
}
