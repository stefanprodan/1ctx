/**
 * (1ctx) diff's lines: a file split at newlines, its last line incomplete
 * when no newline ends it, and each line interned to a number after the
 * options' folding, so the compare works on numbers and the output prints
 * the line itself.
 */

export interface Lines {
  lines: string[];
  /** the last line has no newline */
  incomplete: boolean;
}

export function splitLines(text: string): Lines {
  if (text === "") return { lines: [], incomplete: false };
  const incomplete = !text.endsWith("\n");
  const lines = (incomplete ? text : text.slice(0, -1)).split("\n");
  return { lines, incomplete };
}

export interface Folding {
  ignoreCase?: boolean;
}

export interface Interned {
  a: Int32Array;
  b: Int32Array;
  /** the numbers are below this */
  count: number;
}

export function intern(a: Lines, b: Lines, folding: Folding): Interned {
  const ids = new Map<string, number>();
  const number = (file: Lines): Int32Array => {
    const out = new Int32Array(file.lines.length);
    const last = file.lines.length - 1;
    for (let i = 0; i <= last; i++) {
      let key = file.lines[i];
      if (folding.ignoreCase) key = key.toLowerCase();
      // an incomplete line never matches a complete one
      if (i === last && file.incomplete) key += "\n";
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
