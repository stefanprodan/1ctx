/**
 * (1ctx) How rg prints a path and a line: --path-separator, and -M with
 * --max-columns-preview and --trim in ripgrep's words.
 */

import { utf8ByteLength } from "../../encoding.js";
import type { LineKind } from "../search-engine/index.js";
import type { RgOptions } from "./rg-options.js";

/** A path as printed: --path-separator in place of each /. */
export function shownPath(path: string, options: RgOptions): string {
  const sep = options.pathSeparator;
  return sep === null || sep === "/" ? path : path.replaceAll("/", sep);
}

/** ripgrep's --trim: the ASCII whitespace at a line's start. */
const LEADING = /^[ \t\n\v\f\r]+/;

/** The index after the first `count` code points of a text. */
function codePoints(text: string, count: number): number {
  let index = 0;
  for (let n = 0; n < count && index < text.length; n++) {
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }
  return index;
}

function more(count: number): string {
  return `[... ${count} more ${count === 1 ? "match" : "matches"}]`;
}

/** The matcher's `display`, or nothing when neither -M nor --trim is on. */
export function lineDisplay(
  options: RgOptions,
):
  | ((text: string, kind: LineKind, starts: number[], ends: number) => string)
  | undefined {
  const limit = options.maxColumns;
  if (limit === 0 && !options.trim) return undefined;
  return (text, kind, starts, ends) => {
    let line = text;
    let at = starts;
    // the limit counts the line as it was, before --trim, with its end
    const long = limit > 0 && utf8ByteLength(line) + ends > limit;
    if (options.trim) {
      const cut = LEADING.exec(line)?.[0].length ?? 0;
      line = line.slice(cut);
      at = starts.map((start) => start - cut);
    }
    if (!long) return line;
    if (!options.maxColumnsPreview) {
      if (kind === "context") return "[Omitted long context line]";
      if (kind === "spans") {
        return `[Omitted long line with ${at.length} matches]`;
      }
      return "[Omitted long matching line]";
    }
    const end = codePoints(line, limit);
    const preview = line.slice(0, end);
    if (kind === "spans" || kind === "only") {
      const after = at.filter((start) => start >= end).length;
      return `${preview} ${more(after)}`;
    }
    return `${preview} [... omitted end of long line]`;
  };
}
