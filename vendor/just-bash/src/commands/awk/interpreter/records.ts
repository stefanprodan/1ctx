/**
 * (1ctx) AWK record reader.
 *
 * Reads one record at a time under the RS in force at each call, as gawk
 * does: a newline or any single character separates literally, "" is
 * paragraph mode, and two or more characters are a regular expression.
 * RT is the text that ended the record.
 */

import { ExecutionAbortedError } from "../../../interpreter/errors.js";
import { createUserRegex, type UserRegex } from "../../../regex/index.js";

export interface AwkRecord {
  record: string;
  rt: string;
  next: number;
}

const compiled = new Map<string, UserRegex>();
const MAX_COMPILED = 16;

/** The record that starts at `from`, or null at the end of the text. */
export function nextRecord(
  text: string,
  from: number,
  rs: string,
  signal?: AbortSignal,
): AwkRecord | null {
  if (signal?.aborted) throw new ExecutionAbortedError();
  if (rs === "") return paragraph(text, from, signal);
  if (from >= text.length) return null;
  if (rs.length === 1) {
    const at = text.indexOf(rs, from);
    if (at < 0) return { record: text.slice(from), rt: "", next: text.length };
    return { record: text.slice(from, at), rt: rs, next: at + 1 };
  }
  const match = separator(rs).scan(text, from);
  if (!match) return { record: text.slice(from), rt: "", next: text.length };
  return {
    record: text.slice(from, match.start),
    rt: text.slice(match.start, match.end),
    next: match.end,
  };
}

function paragraph(
  text: string,
  from: number,
  signal?: AbortSignal,
): AwkRecord | null {
  let start = from;
  while (start < text.length && text.charCodeAt(start) === 10) {
    checkAbort(start, signal);
    start++;
  }
  if (start >= text.length) return null;
  const at = text.indexOf("\n\n", start);
  if (at < 0) {
    const last = text.endsWith("\n") ? text.length - 1 : text.length;
    return {
      record: text.slice(start, last),
      rt: text.slice(last),
      next: text.length,
    };
  }
  let end = at + 2;
  while (end < text.length && text.charCodeAt(end) === 10) {
    checkAbort(end, signal);
    end++;
  }
  return { record: text.slice(start, at), rt: text.slice(at, end), next: end };
}

function checkAbort(index: number, signal?: AbortSignal): void {
  if ((index & 4095) === 0 && signal?.aborted) {
    throw new ExecutionAbortedError();
  }
}

function separator(rs: string): UserRegex {
  let regex = compiled.get(rs);
  if (regex) return regex;
  regex = createUserRegex(rs);
  // gawk splits erratically on a separator that matches the empty string
  if (regex.test("")) {
    throw new Error("RS matches the empty string");
  }
  if (compiled.size >= MAX_COMPILED) compiled.clear();
  compiled.set(rs, regex);
  return regex;
}
