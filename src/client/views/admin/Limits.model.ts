// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LimitName, LimitRow } from "../../../shared/contracts/limit.ts";
import { pluralCommas } from "../../lib/format.ts";
import { K, thousandsText, thousandsValue } from "../../lib/thousands.ts";
import { LIMIT_WORDS } from "./Limits.words.ts";

export { LIMIT_WORDS };

// thousands: typed in whole thousands as the agent's window is, a
// stored value shown rounded
type Display = { word: string; factor: number; thousands?: true };

const KB = 1024;
const MB = 1024 * KB;

export function displayOf(row: LimitRow): Display {
  switch (row.unit) {
    case "ms":
      return { word: "s", factor: 1000 };
    case "bytes":
      return row.default >= MB
        ? { word: "MB", factor: MB }
        : { word: "KB", factor: KB };
    case "chars":
      return { word: "chars", factor: 1 };
    case "tokens":
      return { word: "K", factor: K, thousands: true };
    case "days":
      return { word: "days", factor: 1 };
    case "minutes":
      return { word: "min", factor: 1 };
    case "hours":
      return { word: "h", factor: 1 };
    case "pixels":
      return { word: "px", factor: 1 };
    case "mebibytes":
      return { word: "MB", factor: 1 };
    default:
      return { word: "", factor: 1 };
  }
}

// milliseconds and binary byte factors have finite decimal forms, so
// the full number keeps every integer the server accepts through a save
export function show(row: LimitRow, value: number): string {
  const { factor, thousands } = displayOf(row);
  return thousands ? thousandsText(value) : String(value / factor);
}

// the fields Use defaults filled: each stands for its default until it
// is typed in, since a stored 4400 and the default 4096 both show 4
export type Defaulted = ReadonlySet<string>;
const NONE: Defaulted = new Set();

// thousands left as shown give back the value the field stands for, so a
// save of another field never rewrites 4096; typed by hand, the text of
// the stored value keeps it, as the agent's window does
export function read(
  row: LimitRow,
  text: string,
  defaulted: Defaulted = NONE,
): number | null {
  if (displayOf(row).thousands) {
    const kept = defaulted.has(row.name) ? row.default : row.value;
    return thousandsValue(text, [kept]);
  }
  const t = text.trim();
  if (t === "" || !/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * displayOf(row).factor);
}

export function problem(
  row: LimitRow,
  text: string,
  defaulted: Defaulted = NONE,
): string | null {
  const value = read(row, text, defaulted);
  const { label } = LIMIT_WORDS[row.name];
  const { word, thousands } = displayOf(row);
  const unit = word === "" ? "" : ` ${word}`;
  // thousands in the agent window's words: 10 to 10,000 K
  const bound = (n: number) =>
    thousands ? Number(show(row, n)).toLocaleString("en-US") : show(row, n);
  const range = `${label} must be ${thousands ? "a whole number " : ""}from ${bound(row.min)} to ${bound(row.max)}${unit}`;
  if (value === null) {
    return thousands && text.trim() !== "" ? range : `${label} needs a number`;
  }
  if (value < row.min || value > row.max) return range;
  return null;
}

// lowering the days deletes the chats past them at the next sweep
export function deleteAsk(
  rows: LimitRow[],
  draft: Record<string, string>,
): string | null {
  const row = rows.find((r) => r.name === "archivedDeleteDays");
  if (row === undefined) return null;
  const text = draft[row.name] ?? "";
  if (problem(row, text) !== null) return null;
  const next = read(row, text);
  if (next === null || next >= row.value) return null;
  return `Delete chats archived over ${pluralCommas(next, "day", "days")} ago?`;
}

// Keep takes back only the lowered days
export function keepDays(
  rows: LimitRow[],
  draft: Record<string, string>,
): Record<string, string> {
  const row = rows.find((r) => r.name === "archivedDeleteDays");
  return row === undefined
    ? draft
    : { ...draft, [row.name]: show(row, row.value) };
}

export function draftOf(rows: LimitRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) out[row.name] = show(row, row.value);
  return out;
}

export function collect(
  rows: LimitRow[],
  draft: Record<string, string>,
  defaulted: Defaulted = NONE,
):
  | { values: Record<LimitName, number> }
  | { problem: string; field: LimitName } {
  const values = {} as Record<LimitName, number>;
  for (const row of rows) {
    const text = draft[row.name] ?? "";
    const why = problem(row, text, defaulted);
    if (why !== null) return { problem: why, field: row.name };
    values[row.name] = read(row, text, defaulted) as number;
  }
  const out = unordered(rows, values);
  return out ?? { values };
}

// each pair reads lower first; the server refuses a save that breaks one
const ORDERED: readonly [LimitName, LimitName][] = [
  ["sendsPerUser", "sendsPerProject"],
  ["sendsPerProject", "sendsRunning"],
];

// the pair a draft breaks, put on the field that was changed
function unordered(
  rows: LimitRow[],
  values: Record<LimitName, number>,
): { problem: string; field: LimitName } | null {
  for (const [low, high] of ORDERED) {
    const lowRow = rows.find((row) => row.name === low);
    const highRow = rows.find((row) => row.name === high);
    if (lowRow === undefined || highRow === undefined) continue;
    if (values[low] <= values[high]) continue;
    return {
      problem: `${LIMIT_WORDS[low].label} must not be above ${LIMIT_WORDS[high].label}`,
      field: values[low] !== lowRow.value ? low : high,
    };
  }
  return null;
}

export function seedOf(rows: LimitRow[]): string {
  return rows.map((row) => `${row.name}=${row.value}`).join(",");
}

// a limit refusal opens with the limit's name
export function limitFieldOf(message: string): LimitName | undefined {
  const name = message.split(" ", 1)[0] as LimitName;
  return name in LIMIT_WORDS ? name : undefined;
}

// a server refusal in the page's words: each limit's name becomes its
// label, the field kept from the name it opened with
export function limitRefusal(message: string): {
  words: string;
  field: LimitName | undefined;
} {
  const words = message.replace(/\b[a-z][A-Za-z]+\b/g, (word) =>
    Object.hasOwn(LIMIT_WORDS, word)
      ? LIMIT_WORDS[word as LimitName].label
      : word,
  );
  return { words, field: limitFieldOf(message) };
}

export function dirty(
  rows: LimitRow[],
  draft: Record<string, string>,
  defaulted: Defaulted = NONE,
) {
  return rows.some(
    (row) => read(row, draft[row.name] ?? "", defaulted) !== row.value,
  );
}

// by value, not text: a stored 4400 shows as the default 4096 does
export function atDefaults(
  rows: LimitRow[],
  draft: Record<string, string>,
  defaulted: Defaulted = NONE,
) {
  return rows.every(
    (row) => read(row, draft[row.name] ?? "", defaulted) === row.default,
  );
}

// Use defaults: every field shows its default and stands for it
export function defaultsDraft(rows: LimitRow[]): {
  draft: Record<string, string>;
  defaulted: Defaulted;
} {
  return {
    draft: draftOf(rows.map((row) => ({ ...row, value: row.default }))),
    defaulted: new Set(rows.map((row) => row.name)),
  };
}

export function defaultLine(row: LimitRow): string {
  const { word } = displayOf(row);
  return `default ${show(row, row.default)}${word === "" ? "" : ` ${word}`}`;
}
