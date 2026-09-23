/**
 * AWK Field Operations
 *
 * Handles $0, $1, $2, etc. field access and modification.
 */

import { createUserRegex, type UserRegex } from "../../../regex/index.js";
import { chars } from "../chars.js";
import type { AwkRuntimeContext } from "./context.js";
import { toStr } from "./type-coercion.js";
import type { AwkValue } from "./types.js";

/**
 * (1ctx) A field separator as gawk reads FS: " " is runs of space, tab and
 * newline with the ends trimmed, "" each character, any other single
 * character that character, and two or more characters a regex.
 */
export type FieldSeparator =
  | { kind: "space" }
  | { kind: "chars" }
  | { kind: "char"; char: string }
  | { kind: "regex"; regex: UserRegex };

export const SPACE_SEPARATOR: FieldSeparator = { kind: "space" };

export function compileSeparator(fs: string): FieldSeparator {
  if (fs === " ") return SPACE_SEPARATOR;
  if (fs === "") return { kind: "chars" };
  if (fs.length === 1) return { kind: "char", char: fs };
  return { kind: "regex", regex: createUserRegex(fs) };
}

/**
 * (1ctx) Fields and the separators between them. seps[i] is the text
 * between fields i and i+1 (from 1); under the space separator seps[0]
 * and seps[n] hold the leading and trailing whitespace when there is any.
 */
export interface SplitText {
  fields: string[];
  seps: Map<number, string>;
}

const SPACE_RUN = /[ \t\n]+/g;

export function splitText(text: string, sep: FieldSeparator): SplitText {
  const fields: string[] = [];
  const seps = new Map<number, string>();
  if (sep.kind === "space") {
    SPACE_RUN.lastIndex = 0;
    let pos = 0;
    for (let m = SPACE_RUN.exec(text); m; m = SPACE_RUN.exec(text)) {
      if (m.index === 0) {
        seps.set(0, m[0]);
      } else {
        fields.push(text.slice(pos, m.index));
        seps.set(fields.length, m[0]);
      }
      pos = m.index + m[0].length;
    }
    if (pos < text.length) {
      fields.push(text.slice(pos));
      seps.delete(fields.length);
    }
    return { fields, seps };
  }
  if (text === "") return { fields, seps };
  if (sep.kind === "chars") return { fields: chars(text), seps };
  let pos = 0;
  let from = 0;
  for (;;) {
    let start: number;
    let end: number;
    if (sep.kind === "char") {
      start = text.indexOf(sep.char, from);
      end = start + 1;
    } else {
      const m = sep.regex.scan(text, from);
      start = m ? m.start : -1;
      end = m ? m.end : -1;
      // an empty match separates nothing
      if (m && end === start) {
        from = start + 1;
        if (from > text.length) start = -1;
        else continue;
      }
    }
    if (start < 0) break;
    fields.push(text.slice(pos, start));
    seps.set(fields.length, text.slice(start, end));
    pos = end;
    from = end;
  }
  fields.push(text.slice(pos));
  return { fields, seps };
}

/**
 * Split a record into fields based on the field separator.
 * (1ctx) The one splitter for records, $0 assignments and sub/gsub on $0:
 * in paragraph mode (RS == "") a newline also separates fields.
 */
export function splitRecord(ctx: AwkRuntimeContext, line: string): string[] {
  // Empty line always has 0 fields in AWK
  if (line === "") {
    return [];
  }
  const sep = ctx.fieldSep;
  if (ctx.RS === "" && sep.kind !== "space" && sep.kind !== "chars") {
    return line.split("\n").flatMap((part) => splitText(part, sep).fields);
  }
  return splitText(line, sep).fields;
}

/**
 * Get a field value by index.
 * $0 is the whole line, $1 is first field, etc.
 */
export function getField(ctx: AwkRuntimeContext, index: number): AwkValue {
  if (index === 0) {
    return ctx.line;
  }
  // (1ctx) gawk's fatal error
  if (index < 0) throw new Error(`attempt to access field ${index}`);
  if (index > ctx.fields.length) {
    return "";
  }
  return ctx.fields[index - 1] ?? "";
}

/**
 * Set a field value by index.
 * Setting $0 re-splits the line. Setting other fields rebuilds $0.
 */
export function setField(
  ctx: AwkRuntimeContext,
  index: number,
  value: AwkValue,
): void {
  if (index === 0) {
    // Setting $0 re-splits the line
    ctx.line = toStr(ctx, value);
    ctx.fields = splitRecord(ctx, ctx.line);
    ctx.NF = ctx.fields.length;
  } else if (index > 0) {
    // Extend fields array if needed
    while (ctx.fields.length < index) {
      ctx.fields.push("");
    }
    ctx.fields[index - 1] = toStr(ctx, value);
    ctx.NF = ctx.fields.length;
    // Rebuild $0 from fields
    ctx.line = ctx.fields.join(ctx.OFS);
  }
}

/**
 * Update context with a new line (used when processing input).
 */
export function setCurrentLine(ctx: AwkRuntimeContext, line: string): void {
  ctx.line = line;
  ctx.fields = splitRecord(ctx, line);
  ctx.NF = ctx.fields.length;
}

/**
 * Update field separator and recompile regex.
 */
export function setFieldSeparator(ctx: AwkRuntimeContext, fs: string): void {
  ctx.fieldSep = compileSeparator(fs);
  ctx.FS = fs;
}
