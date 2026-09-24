/**
 * (1ctx) GNU grep's basic and extended regular expressions, translated to
 * RE2 syntax. RE2 stays the engine; this reads the dialect GNU grep 3.12
 * reads, with its escapes, its intervals, its literal `{` and `)`, its
 * warnings and its errors, and refuses what RE2 cannot run.
 */

export type GnuMode = "basic" | "extended";

/** A pattern GNU grep refuses, or one RE2 cannot run; exit status 2. */
export class GnuPatternError extends Error {
  /** which of several patterns it was, set by the caller that joins them */
  index?: number;
}

export interface GnuTranslation {
  /** RE2 syntax */
  source: string;
  /** GNU's warnings, each once, without the `grep: warning: ` prefix */
  warnings: string[];
}

const WORD = "\\p{L}\\p{N}_";
const SPACE = "\\t\\n\\v\\f\\r ";

/** The members of each POSIX class inside an RE2 bracket, Unicode as GNU's locale reads them. */
const CLASSES = new Map<string, string>([
  ["alpha", "\\p{L}"],
  ["digit", "0-9"],
  ["alnum", "\\p{L}\\p{N}"],
  ["upper", "\\p{Lu}"],
  ["lower", "\\p{Ll}"],
  ["xdigit", "0-9A-Fa-f"],
  ["space", SPACE],
  ["blank", " \\t"],
  ["punct", "!-/:-@\\[-`{-~"],
  ["graph", "!-~\\p{L}\\p{N}\\p{P}\\p{S}"],
  ["print", " -~\\p{L}\\p{N}\\p{P}\\p{S}"],
  ["cntrl", "\\x00-\\x1F\\x7F"],
]);

const RE2_SPECIAL = new Set([..."\\.+*?()|[]{}^$"]);

function literal(ch: string): string {
  return RE2_SPECIAL.has(ch) ? `\\${ch}` : ch;
}

function classLiteral(ch: string): string {
  return ch === "\\" || ch === "]" || ch === "[" || ch === "^" || ch === "-"
    ? `\\${ch}`
    : ch;
}

function codePointAt(s: string, i: number): string {
  const cp = s.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/**
 * Parse a bracket expression starting at `start` (the `[`). Returns the RE2
 * class and the index after the closing `]`.
 */
function bracket(pattern: string, start: number): { re: string; end: number } {
  const unmatched = "Unmatched [, [^, [:, [., or [=";
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "^") {
    negate = true;
    i++;
  }
  const items: string[] = [];
  // the last single character added, for a range
  let last: string | null = null;
  let first = true;
  const contentStart = i;
  while (true) {
    if (i >= pattern.length) throw new GnuPatternError(unmatched);
    const ch = pattern[i];
    if (ch === "]" && !first) break;
    first = false;
    if (ch === "[" && ":=.".includes(pattern[i + 1] ?? "")) {
      const kind = pattern[i + 1];
      const close = pattern.indexOf(`${kind}]`, i + 2);
      if (close === -1) throw new GnuPatternError(unmatched);
      const name = pattern.slice(i + 2, close);
      i = close + 2;
      if (kind === ":") {
        const members = CLASSES.get(name);
        if (members === undefined) {
          throw new GnuPatternError("Invalid character class name");
        }
        items.push(members);
        last = null;
      } else {
        // an equivalence class or a collating symbol names one character here
        const cp = codePointAt(name, 0);
        if (cp === "" || cp.length !== name.length) {
          throw new GnuPatternError("Invalid collation character");
        }
        items.push(classLiteral(cp));
        last = cp;
      }
      continue;
    }
    if (
      ch === "-" &&
      last !== null &&
      pattern[i + 1] !== undefined &&
      pattern[i + 1] !== "]"
    ) {
      let endCh = codePointAt(pattern, i + 1);
      let next = i + 1 + endCh.length;
      if (endCh === "[" && pattern[i + 2] === ".") {
        const close = pattern.indexOf(".]", i + 3);
        if (close === -1) throw new GnuPatternError(unmatched);
        endCh = pattern.slice(i + 3, close);
        next = close + 2;
      }
      if ((endCh.codePointAt(0) ?? 0) < (last.codePointAt(0) ?? 0)) {
        throw new GnuPatternError("Invalid range end");
      }
      items.push(`-${classLiteral(endCh)}`);
      last = null;
      i = next;
      continue;
    }
    const cp = codePointAt(pattern, i);
    items.push(classLiteral(cp));
    last = cp;
    i += cp.length;
  }
  const content = pattern.slice(contentStart, i);
  if (/^:[^:]*:$/.test(content) && !negate) {
    throw new GnuPatternError(
      "character class syntax is [[:space:]], not [:space:]",
    );
  }
  return { re: `[${negate ? "^" : ""}${items.join("")}]`, end: i + 1 };
}

interface Piece {
  /** RE2 text of this atom, with any repetition applied */
  re: string;
  /** a repetition may follow it */
  repeatable: boolean;
  /** it already carries a repetition */
  repeated: boolean;
}

/**
 * Parse an interval body starting just after `{` (ERE) or `\{` (BRE). Returns
 * the RE2 repetition and the index after the closing brace, or null when it
 * is not an interval.
 */
function interval(
  pattern: string,
  start: number,
  basic: boolean,
): { re: string; end: number } | null {
  const close = basic ? "\\}" : "}";
  const m = /^(\d*)(,(\d*))?/.exec(pattern.slice(start));
  const body = m ? m[0] : "";
  const after = start + body.length;
  if (!pattern.startsWith(close, after)) {
    if (basic) {
      throw new GnuPatternError(
        pattern.indexOf("\\}", start) === -1
          ? "Unmatched \\{"
          : "Invalid content of \\{\\}",
      );
    }
    return null;
  }
  const min = m?.[1] ?? "";
  const hasComma = m?.[2] !== undefined;
  const max = m?.[3] ?? "";
  if (min === "" && !hasComma) {
    if (basic) throw new GnuPatternError("Invalid content of \\{\\}");
    return null;
  }
  const lo = min === "" ? 0 : Number(min);
  const hi = hasComma ? (max === "" ? Infinity : Number(max)) : lo;
  if (lo > hi) throw new GnuPatternError("Invalid content of \\{\\}");
  if (lo > 32767 || (hi !== Infinity && hi > 32767)) {
    throw new GnuPatternError("Regular expression too big");
  }
  const re = !hasComma
    ? `{${lo}}`
    : hi === Infinity
      ? `{${lo},}`
      : `{${lo},${hi}}`;
  return { re, end: after + close.length };
}

/** Translate one GNU BRE or ERE pattern to RE2 syntax. */
export function translateGnu(pattern: string, mode: GnuMode): GnuTranslation {
  const basic = mode === "basic";
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  // one frame per open group: its alternatives, each a list of pieces
  const stack: { alts: Piece[][] }[] = [{ alts: [[]] }];
  const top = () => stack[stack.length - 1];
  const current = () => {
    const alts = top().alts;
    return alts[alts.length - 1];
  };
  const atStart = () => current().length === 0;
  const push = (re: string, repeatable = true) =>
    current().push({ re, repeatable, repeated: false });

  const repeat = (op: string, name: string) => {
    const pieces = current();
    const prev = pieces[pieces.length - 1];
    if (!prev || !prev.repeatable) {
      // GNU repeats nothing: the operator matches the empty string
      warn(`${name} at start of expression`);
      return;
    }
    if (prev.repeated) prev.re = `(?:${prev.re})`;
    prev.re += op;
    prev.repeated = true;
  };

  const n = pattern.length;
  let i = 0;
  while (i < n) {
    const ch = pattern[i];
    if (ch === "\\") {
      if (i + 1 >= n) throw new GnuPatternError("Trailing backslash");
      const next = codePointAt(pattern, i + 1);
      i += 1 + next.length;
      if (basic && next === "(") {
        stack.push({ alts: [[]] });
        continue;
      }
      if (basic && next === ")") {
        if (stack.length === 1) {
          throw new GnuPatternError("Unmatched ) or \\)");
        }
        closeGroup();
        continue;
      }
      if (basic && next === "|") {
        top().alts.push([]);
        continue;
      }
      if (basic && next === "{") {
        if (atStart()) {
          warn("stray \\ before {");
          push("\\{");
          continue;
        }
        const iv = interval(pattern, i, true);
        if (iv) {
          repeat(iv.re, "{...}");
          i = iv.end;
        }
        continue;
      }
      if (basic && (next === "+" || next === "?")) {
        if (atStart()) {
          push(literal(next));
          continue;
        }
        repeat(next, next);
        continue;
      }
      if (next >= "1" && next <= "9") {
        throw new GnuPatternError(
          `backreference \\${next} is not supported: the regex engine is RE2, which has no backreferences`,
        );
      }
      switch (next) {
        case "<":
        case ">":
        case "b":
          push("\\b", false);
          continue;
        case "B":
          push("\\B", false);
          continue;
        case "`":
          push("\\A", false);
          continue;
        case "'":
          push("\\z", false);
          continue;
        case "w":
          push(`[${WORD}]`);
          continue;
        case "W":
          push(`[^${WORD}]`);
          continue;
        case "s":
          push(`[${SPACE}]`);
          continue;
        case "S":
          push(`[^${SPACE}]`);
          continue;
        // a model writing \d means a digit, where GNU warns and reads d
        case "d":
          push("[0-9]");
          continue;
        case "D":
          push("[^0-9]");
          continue;
      }
      if ("\\.*[]^$".includes(next) || (!basic && "+?{}()|".includes(next))) {
        push(literal(next));
        continue;
      }
      if (basic && next === "}") {
        push("\\}");
        continue;
      }
      const shown =
        next === " " || next === "\t" ? "white space" : next.trim() || next;
      warn(
        /[\p{Cc}]/u.test(next)
          ? "stray \\ before unprintable character"
          : `stray \\ before ${shown}`,
      );
      push(literal(next));
      continue;
    }
    // BSD's word boundaries, which upstream read too
    if (pattern.startsWith("[[:<:]]", i) || pattern.startsWith("[[:>:]]", i)) {
      push("\\b", false);
      i += 7;
      continue;
    }
    if (ch === "[") {
      const b = bracket(pattern, i);
      push(b.re);
      i = b.end;
      continue;
    }
    if (ch === "*") {
      i++;
      const pieces = current();
      if (
        basic &&
        (atStart() || (pieces.length === 1 && pieces[0].re === "^"))
      ) {
        push("\\*");
        continue;
      }
      repeat("*", "*");
      continue;
    }
    if (!basic && (ch === "+" || ch === "?")) {
      i++;
      repeat(ch, ch);
      continue;
    }
    if (!basic && ch === "{") {
      const iv = interval(pattern, i + 1, false);
      if (!iv) {
        push("\\{");
        i++;
        continue;
      }
      i = iv.end;
      repeat(iv.re, "{...}");
      continue;
    }
    if (!basic && ch === "(") {
      stack.push({ alts: [[]] });
      i++;
      continue;
    }
    if (!basic && ch === ")") {
      i++;
      if (stack.length === 1) {
        push("\\)");
        continue;
      }
      closeGroup();
      continue;
    }
    if (!basic && ch === "|") {
      top().alts.push([]);
      i++;
      continue;
    }
    if (ch === "^") {
      i++;
      if (!basic || atStart()) {
        push("^", false);
      } else {
        push("\\^");
      }
      continue;
    }
    if (ch === "$") {
      i++;
      const end =
        !basic ||
        i === n ||
        pattern.startsWith("\\)", i) ||
        pattern.startsWith("\\|", i);
      push(end ? "$" : "\\$", !end);
      continue;
    }
    const cp = codePointAt(pattern, i);
    push(ch === "." ? "." : literal(cp));
    i += cp.length;
  }
  if (stack.length > 1) throw new GnuPatternError("Unmatched ( or \\(");
  return { source: join(stack[0].alts), warnings };

  function closeGroup() {
    const frame = stack.pop();
    if (!frame) return;
    push(`(${join(frame.alts)})`);
  }
}

function join(alts: Piece[][]): string {
  return alts.map((pieces) => pieces.map((p) => p.re).join("")).join("|");
}
