/**
 * (1ctx diff-engine diff-bytes) diff's lines: a file's bytes, one character per byte, split at
 * newlines, its last line incomplete when no newline ends it, and each
 * line interned to a number after the options' folding, so the compare
 * works on numbers and the output prints the line's own bytes. Case folds
 * over UTF-8 where a line decodes and over ASCII where it does not.
 */

export interface Lines {
  lines: string[];
  /** the last line has no newline */
  incomplete: boolean;
}

export function splitLines(bytes: string, stripTrailingCr = false): Lines {
  if (bytes === "") return { lines: [], incomplete: false };
  const incomplete = !bytes.endsWith("\n");
  const lines = (incomplete ? bytes : bytes.slice(0, -1)).split("\n");
  if (stripTrailingCr) {
    const last = incomplete ? lines.length - 1 : lines.length;
    for (let i = 0; i < last; i++) {
      if (lines[i].endsWith("\r")) lines[i] = lines[i].slice(0, -1);
    }
  }
  return { lines, incomplete };
}

export interface Folding {
  ignoreCase?: boolean;
  ignoreTabExpansion?: boolean;
  ignoreTrailingSpace?: boolean;
  ignoreSpaceChange?: boolean;
  ignoreAllSpace?: boolean;
  tabSize?: number;
  /** ed styles: an incomplete last line matches a complete one */
  completeLines?: boolean;
  /** takes the spaces -E expands tabs to */
  charge?: (steps: number) => void;
}

export interface Interned {
  a: Int32Array;
  b: Int32Array;
  /** the numbers are below this */
  count: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** The line's text when its bytes are UTF-8, else null. */
export function decodeLine(line: string): string | null {
  if (!/[\x80-\xff]/.test(line)) return line;
  try {
    return utf8.decode(Uint8Array.from(line, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function toBytes(text: string): string {
  let out = "";
  for (const byte of encoder.encode(text)) out += String.fromCharCode(byte);
  return out;
}

/**
 * Case folded one character at a time, as GNU's answers show: no final
 * sigma, and a capital that lowercases to several characters takes the
 * first.
 */
function lowerBytes(line: string): string {
  const text = decodeLine(line);
  if (text === null) return line.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  if (text === line) return line.toLowerCase();
  let lower = "";
  for (const ch of text) {
    lower += String.fromCodePoint(ch.toLowerCase().codePointAt(0) as number);
  }
  return toBytes(lower);
}

// East Asian wide and fullwidth ranges, two columns each
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];
const COMBINING = /^\p{M}$/u;

/** The columns a character takes on a terminal. */
export function columns(ch: string): number {
  const code = ch.codePointAt(0) as number;
  if (code < 0x300) return 1;
  if (COMBINING.test(ch)) return 0;
  for (const [lo, hi] of WIDE) if (code >= lo && code <= hi) return 2;
  return 1;
}

/**
 * Tabs to the next stop, a character taking the columns a terminal gives
 * it and a byte that is not UTF-8 one column, as GNU's manual has it.
 */
export function expandTabs(
  line: string,
  size: number,
  charge?: (steps: number) => void,
): string {
  if (!line.includes("\t")) return line;
  const text = decodeLine(line);
  let out = "";
  let column = 0;
  for (const ch of text ?? line) {
    if (ch === "\t") {
      const spaces = size - (column % size);
      // a tab size can ask for more spaces than memory holds
      charge?.(spaces);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += ch;
      column += text === null ? 1 : columns(ch);
    }
  }
  return text === null || text === line ? out : toBytes(out);
}

/** White space as GNU's manual lists it: tab, vertical tab, form feed, return, space. */
const TRAILING = /[\t\v\f\r ]+$/;
const RUNS = /[\t\v\f\r ]+/g;

/** Whether folding makes an incomplete line match a complete one. */
export function foldsNewline(folding: Folding): boolean {
  return !!(
    folding.ignoreAllSpace ||
    folding.ignoreSpaceChange ||
    folding.ignoreTrailingSpace
  );
}

export function foldLine(line: string, folding: Folding): string {
  let key = line;
  if (folding.ignoreCase) key = lowerBytes(key);
  if (folding.ignoreAllSpace) return key.replace(RUNS, "");
  if (folding.ignoreSpaceChange) {
    return key.replace(TRAILING, "").replace(RUNS, " ");
  }
  if (folding.ignoreTabExpansion) {
    key = expandTabs(key, folding.tabSize ?? 8, folding.charge);
  }
  if (folding.ignoreTrailingSpace) key = key.replace(TRAILING, "");
  return key;
}

/** Whether any option folds lines before they are compared. */
export function folds(folding: Folding): boolean {
  return !!(
    folding.ignoreCase ||
    folding.ignoreTabExpansion ||
    folding.ignoreTrailingSpace ||
    folding.ignoreSpaceChange ||
    folding.ignoreAllSpace
  );
}

export function intern(a: Lines, b: Lines, folding: Folding): Interned {
  const ids = new Map<string, number>();
  const plain = !folds(folding);
  const newlineFolds = foldsNewline(folding);
  const number = (file: Lines): Int32Array => {
    const out = new Int32Array(file.lines.length);
    const last = file.lines.length - 1;
    for (let i = 0; i <= last; i++) {
      let key = plain ? file.lines[i] : foldLine(file.lines[i], folding);
      // an incomplete line matches a complete one only when white space
      // is ignored
      if (
        i === last &&
        file.incomplete &&
        !newlineFolds &&
        !folding.completeLines
      ) {
        key += "\n";
      }
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  };
  const na = number(a);
  const nb = number(b);
  return { a: na, b: nb, count: ids.size };
}
