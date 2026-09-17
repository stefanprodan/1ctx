// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the tools page shows and checks without a DOM: the words of
// each limit, the unit each row is typed in (seconds for a
// millisecond cap, KB or MB for a byte cap) and the conversion both
// ways, the range check the server applies, and the lines of the
// search section, the tabs and when a send carries a built-in.

import type { LimitRow } from "../../../shared/contracts/limit.ts";
import {
  DEFAULT_VISUAL_HOSTS,
  type SearchState,
  type ToolWhen,
} from "../../../shared/contracts/tool.ts";
import type {
  LimitName,
  LimitScope,
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
    text: "webfetch calls a send may make. Zero keeps the tool but spends nothing.",
  },
  maxSearches: {
    label: "Searches per send",
    text: "websearch calls a send may make. Zero keeps the tool but spends nothing.",
  },
  fetchBodyBytes: {
    label: "Fetch body",
    text: "Bytes a fetched page is read up to.",
  },
  searchBodyBytes: {
    label: "Search body",
    text: "Bytes a search answer is read up to.",
  },
  visualBytes: {
    label: "Visual size",
    text: "Bytes one visual's HTML may contain.",
  },
  visualSendBytes: {
    label: "Visual bytes per send",
    text: "Bytes of HTML a send may accept across its visuals.",
  },
  maxVisuals: {
    label: "Visuals per send",
    text: "visualize calls a send may draw.",
  },
  fetchDeadlineMs: {
    label: "Fetch deadline",
    text: "How long one page request may take.",
  },
  searchDeadlineMs: {
    label: "Search deadline",
    text: "How long one search request may take.",
  },
  contextReserve: {
    label: "Context reserve",
    text: "Room kept in the window. A reply that leaves less is followed by a summary.",
  },
  summaryMaxTokens: {
    label: "Summary tokens",
    text: "Tokens a summary may run to, the reserve at most.",
  },
  memoryPhaseMs: {
    label: "Memory time",
    text: "How long an automation may spend updating its memory.",
  },
  memoryPhaseRounds: {
    label: "Memory rounds",
    text: "Provider turns an automation may spend updating its memory.",
  },
  runDeadlineMs: {
    label: "Run deadline",
    text: "How long an automation's run may take. An automation may set less.",
  },
};

// when a send carries a built-in, over its description
export const WHEN_WORDS: Record<ToolWhen, string> = {
  always: "Sent to every model that takes tools.",
  skills: "Sent when the agent has skills.",
  skillFiles: "Sent when one of the agent's skills has files.",
  mcpCatalog: "Sent when the agent's MCP tools go as a catalog.",
  projectMemory: "Sent in a run that reads the project's chats for its memory.",
  memory:
    "Sent in a run that updates the project's memory, and in the step after a run that updates its own memory.",
};

export const NAMES_WORDS =
  "Shown without names. Each skill or tool name a send lists adds tokens.";

// a card's tokens: every schema in it together
export function totalTokens(rows: { tokens: number }[]): number {
  return rows.reduce((n, row) => n + row.tokens, 0);
}

// the page's tabs, each an address
export type ToolsTab = "builtin" | "web" | "limits";

export const TOOLS_TABS: { tab: ToolsTab; label: string; href: string }[] = [
  { tab: "builtin", label: "Built-in", href: "/admin/tools" },
  { tab: "web", label: "Web", href: "/admin/tools/web" },
  { tab: "limits", label: "Limits", href: "/admin/tools/limits" },
];

export function toolsTab(pathname: string): ToolsTab {
  return TOOLS_TABS.find((t) => t.href === pathname)?.tab ?? "builtin";
}

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
    case "tokens":
      return { word: "tokens", factor: 1 };
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

// the body a Save sends, or the first problem and the limit it is about
export function collect(
  rows: LimitRow[],
  draft: Record<string, string>,
):
  | { values: Record<LimitName, number> }
  | { problem: string; field: LimitName } {
  const values = {} as Record<LimitName, number>;
  for (const row of rows) {
    const text = draft[row.name] ?? "";
    const why = problem(row, text);
    if (why !== null) return { problem: why, field: row.name };
    values[row.name] = read(row, text) as number;
  }
  return { values };
}

// the full set the route takes: one scope's values, and the saved
// value of every other row
export function withSaved(
  rows: LimitRow[],
  scope: LimitScope,
  values: Partial<Record<LimitName, number>>,
): Record<LimitName, number> {
  const out = {} as Record<LimitName, number>;
  for (const row of rows) {
    out[row.name] =
      row.scope === scope ? (values[row.name] ?? row.value) : row.value;
  }
  return out;
}

// what re-seeds a form's fields: its rows' values alone, since every
// save of the full set moves the change time of each kept override
export function seedOf(rows: LimitRow[]): string {
  return rows.map((row) => `${row.name}=${row.value}`).join(",");
}

// the defaults of the rows, a reset's values
export function defaultsOf(
  rows: LimitRow[],
): Partial<Record<LimitName, number>> {
  return Object.fromEntries(rows.map((row) => [row.name, row.default]));
}

// which limit a server refusal names: its words open with the name
export function limitFieldOf(message: string): LimitName | undefined {
  const name = message.split(" ", 1)[0] as LimitName;
  return name in LIMIT_WORDS ? name : undefined;
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

// the key file of a provider and whether it is there; every provider
// answers without one, so a missing file is a rate, not a fault
export function keyLine(provider: SearchProvider, present: boolean): string {
  return `${provider}.key ${present ? "present" : "keyless"}`;
}

// what the search section says under the providers
export function searchLine(state: SearchState): string {
  if (state.provider === null) {
    return "Choose a provider. websearch is not offered until one is chosen.";
  }
  if (!state.keys[state.provider]) {
    return `websearch runs on ${state.provider} keyless. Add ${state.provider}.key for a higher rate.`;
  }
  return `websearch runs on ${state.provider}.`;
}

export type HostEdit =
  | { type: "add"; host: string }
  | { type: "remove"; host: string }
  | { type: "reset" };

export function editHosts(hosts: readonly string[], edit: HostEdit): string[] {
  switch (edit.type) {
    case "add":
      return [...hosts, edit.host.trim()];
    case "remove":
      return hosts.filter((host) => host !== edit.host);
    case "reset":
      return [...DEFAULT_VISUAL_HOSTS];
  }
}

export function hostsFieldOf(message: string): "hosts" | undefined {
  return message.startsWith("hosts ") ? "hosts" : undefined;
}

// the first sentence of a description, for the row
export { firstSentence, tokensText } from "../../lib/format.ts";
