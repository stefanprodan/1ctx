/**
 * (1ctx) xargs' input read as GNU xargs 4.11 reads it. By default blanks
 * and newlines separate items, single and double quotes and a backslash
 * protect them, and a line ending in a blank goes on to the next for -L;
 * -I reads whole lines, leading blanks dropped; -0 and -d take every
 * byte literally, each item a line of its own.
 */

import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { XargsInputMode } from "./xargs-options.js";

export interface XargsInput {
  /** the items of each logical input line; under -I, one item a line */
  lines: string[][];
  /** GNU's words for a quote the input never closed, after the lines */
  error: string | null;
  warnings: string[];
}

export interface XargsInputOptions {
  mode: XargsInputMode;
  delimiter: string;
  eof: string | null;
  /** -I: each line is one item */
  wholeLines: boolean;
  maxItems: number;
}

const NUL_WARNING =
  "WARNING: a NUL character occurred in the input.  It cannot be passed " +
  "through in the argument list.  Did you mean to use the --null option?";

function isBlank(c: string): boolean {
  return c === " " || c === "\t";
}

function limitError(maxItems: number): ExecutionLimitError {
  return new ExecutionLimitError(
    `xargs: array element limit exceeded (${maxItems})`,
    "array_elements",
  );
}

function unmatched(quote: string): string {
  const kind = quote === "'" ? "single" : "double";
  return (
    `unmatched ${kind} quote; by default quotes are special to xargs ` +
    "unless you use the -0 option"
  );
}

/** Splits on one character; an empty item between two counts, a final one not. */
function readSeparated(
  text: string,
  separator: string,
  maxItems: number,
): XargsInput {
  const lines: string[][] = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf(separator, start);
    if (end === -1) end = text.length;
    if (lines.length >= maxItems) throw limitError(maxItems);
    lines.push([text.slice(start, end)]);
    start = end + 1;
  }
  return { lines, error: null, warnings: [] };
}

export function readXargsInput(
  text: string,
  options: XargsInputOptions,
): XargsInput {
  if (options.mode === "null") {
    return readSeparated(text, "\0", options.maxItems);
  }
  if (options.mode === "delimiter") {
    return readSeparated(text, options.delimiter, options.maxItems);
  }
  const { eof, maxItems, wholeLines } = options;
  const warnings = text.includes("\0") ? [NUL_WARNING] : [];
  const lines: string[][] = [];
  let line: string[] = [];
  let count = 0;
  let item: string | null = null;
  let quote: string | null = null;
  // the raw character before a newline decides whether a line goes on
  let prev = "\n";
  let stopped = false;

  const endItem = () => {
    if (item === null) return;
    const value = item;
    item = null;
    if (eof !== null && value === eof) {
      stopped = true;
      return;
    }
    if (++count > maxItems) throw limitError(maxItems);
    line.push(value);
  };
  const endLine = () => {
    if (line.length > 0) lines.push(line);
    line = [];
  };

  for (let i = 0; i < text.length && !stopped; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else if (c === "\n") {
        endLine();
        return { lines, error: unmatched(quote), warnings };
      } else {
        item += c;
      }
      prev = c;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < text.length) {
        const next = text[++i];
        item = (item ?? "") + next;
        prev = next;
      } else {
        prev = c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      item ??= "";
      prev = c;
      continue;
    }
    if (c === "\n") {
      if (wholeLines) {
        endItem();
        endLine();
      } else {
        endItem();
        // a blank before the newline carries the line on, as does a
        // blank line; any other line ends here
        if (!isBlank(prev) && prev !== "\n") endLine();
      }
      prev = c;
      continue;
    }
    if (isBlank(c)) {
      if (wholeLines) {
        // leading blanks are dropped, the rest belong to the line
        if (item !== null) item += c;
      } else {
        endItem();
      }
      prev = c;
      continue;
    }
    item = (item ?? "") + c;
    prev = c;
  }
  if (quote !== null && !stopped) {
    endLine();
    return { lines, error: unmatched(quote), warnings };
  }
  if (!stopped) endItem();
  endLine();
  return { lines, error: null, warnings };
}
