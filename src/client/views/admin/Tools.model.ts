// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the tools page shows and checks without a DOM: the words of
// each limit, the unit each row is typed in (seconds for a
// millisecond cap, KB or MB for a byte cap) and the conversion both
// ways, the range check the server applies, and the lines of the
// search section.

import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { SearchState } from "../../../shared/contracts/tool.ts";
import type {
  BuiltinTool,
  LimitName,
  SearchProvider,
} from "../../../shared/words.ts";

// the label over each field and the line under it
export const LIMIT_WORDS: Record<LimitName, { label: string; text: string }> = {
  rounds: {
    label: "Rounds",
    text: "Provider turns a send may take, the answer round included.",
  },
  callsPerRound: {
    label: "Calls per round",
    text: "Tool calls one round may launch, in parallel.",
  },
  callsPerSend: {
    label: "Calls per send",
    text: "Tool calls a send may launch across its rounds.",
  },
  toolMs: {
    label: "Tool time",
    text: "Wall clock spent in tools over a send, every round summed.",
  },
  resultBytes: {
    label: "Result bytes",
    text: "Stored tool results over a send, weighed before a round launches.",
  },
  callTimeoutMs: {
    label: "Call timeout",
    text: "How long one tool call may run.",
  },
  resultCut: {
    label: "Result cut",
    text: "Characters a result is cut to before the model reads it.",
  },
  maxFetches: {
    label: "Fetches per send",
    text: "webfetch calls a send may make; zero keeps the tool but spends nothing.",
  },
  maxSearches: {
    label: "Searches per send",
    text: "websearch calls a send may make; zero keeps the tool but spends nothing.",
  },
  fetchBodyBytes: {
    label: "Fetch body",
    text: "Bytes a fetched page is read up to.",
  },
  searchBodyBytes: {
    label: "Search body",
    text: "Bytes a search answer is read up to.",
  },
  fetchDeadlineMs: {
    label: "Fetch deadline",
    text: "How long one page request may take.",
  },
  searchDeadlineMs: {
    label: "Search deadline",
    text: "How long one search request may take.",
  },
};

export const TOOL_WORDS: Record<BuiltinTool, string> = {
  get_current_time: "The clock, in any timezone.",
  webfetch: "A page by URL, as text.",
  websearch: "The web, through the chosen search provider.",
};

// the unit a row is typed in and how many of the runner's units it is
export type Display = { word: string; factor: number };

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
    default:
      return { word: "", factor: 1 };
  }
}

// a runner value as the page shows it. Milliseconds and binary byte
// factors have finite decimal forms, so keeping the full number lets
// every integer accepted by the server survive a display and save.
export function show(row: LimitRow, value: number): string {
  return String(value / displayOf(row).factor);
}

// what was typed, back in the runner's units and whole; null when it
// is not a number
export function read(row: LimitRow, text: string): number | null {
  const t = text.trim();
  if (t === "" || !/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * displayOf(row).factor);
}

// the server's range check, worded in the page's unit
export function problem(row: LimitRow, text: string): string | null {
  const value = read(row, text);
  const { label } = LIMIT_WORDS[row.name];
  if (value === null) return `${label} needs a number`;
  const { word } = displayOf(row);
  const unit = word === "" ? "" : ` ${word}`;
  if (value < row.min || value > row.max) {
    return `${label} is ${show(row, row.min)} to ${show(row, row.max)}${unit}`;
  }
  return null;
}

// the fields' text as the rows come in
export function draftOf(rows: LimitRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) out[row.name] = show(row, row.value);
  return out;
}

// the body a Save sends, or the first problem
export function collect(
  rows: LimitRow[],
  draft: Record<string, string>,
): { values: Record<LimitName, number> } | { problem: string } {
  const values = {} as Record<LimitName, number>;
  for (const row of rows) {
    const text = draft[row.name] ?? "";
    const why = problem(row, text);
    if (why !== null) return { problem: why };
    values[row.name] = read(row, text) as number;
  }
  return { values };
}

// whether any field differs from its row
export function dirty(rows: LimitRow[], draft: Record<string, string>) {
  return rows.some((row) => read(row, draft[row.name] ?? "") !== row.value);
}

// "default 10", shown faint when the row was changed
export function defaultLine(row: LimitRow): string {
  const { word } = displayOf(row);
  return `default ${show(row, row.default)}${word === "" ? "" : ` ${word}`}`;
}

// the key file of a provider and whether it is there; both providers
// answer without one, so a missing file is a rate, not a fault
export function keyLine(provider: SearchProvider, present: boolean): string {
  return `${provider}.key ${present ? "present" : "keyless"}`;
}

// what the search section says under the two providers
export function searchLine(state: SearchState): string {
  if (state.provider === null) {
    return "Choose a provider. websearch is not offered until one is chosen.";
  }
  if (!state.keys[state.provider]) {
    return `websearch runs on ${state.provider} without a key; ${state.provider}.key in the secrets directory raises the rate.`;
  }
  return `websearch runs on ${state.provider}.`;
}

// the first sentence of a description, for the row
export function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}
