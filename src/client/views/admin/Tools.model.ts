// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the tools page shows and checks without a DOM: the words of
// each limit, the unit each row is typed in (seconds for a
// millisecond cap, KB or MB for a byte cap) and the conversion both
// ways, the range check the server applies, the lines of the search
// section, the visual hosts box, the tabs and when a send carries a
// built-in.

import type { LimitRow } from "../../../shared/contracts/limit.ts";
import {
  DEFAULT_VISUAL_HOSTS,
  type SearchState,
  type ToolWhen,
} from "../../../shared/contracts/tool.ts";
import { parseVisualHosts } from "../../../shared/visual.ts";
import { parseDomains, type WebAccessMode } from "../../../shared/web.ts";
import type {
  LimitName,
  LimitScope,
  SearchProvider,
} from "../../../shared/words.ts";
import { sentence } from "../../lib/format.ts";

// the label over each field and the line under it
export const LIMIT_WORDS: Record<LimitName, { label: string; text: string }> = {
  rounds: {
    label: "Rounds",
    text: "Provider requests a turn may make, the answer round included.",
  },
  callsPerRound: {
    label: "Calls per round",
    text: "Tool calls one round may launch, in parallel.",
  },
  callsPerSend: {
    label: "Calls per turn",
    text: "Tool calls a turn may launch across its rounds.",
  },
  toolMs: {
    label: "Tool time",
    text: "Wall clock spent in tools over a turn, every round summed.",
  },
  resultBytes: {
    label: "Result bytes",
    text: "Stored tool results over a turn, weighed before a round launches.",
  },
  toolWorkTokens: {
    label: "Tool-work tokens",
    text: "Tokens a turn may spend on tools before it must answer. Cached input counts as a tenth.",
  },
  callTimeoutMs: {
    label: "Call timeout",
    text: "How long one tool call may run.",
  },
  resultCut: {
    label: "Result cut",
    text: "Characters a result is cut to before the model reads it.",
  },
  maxBashCalls: {
    label: "Bash calls per turn",
    text: "bash calls a turn may make.",
  },
  maxFetches: {
    label: "Fetches per turn",
    text: "webfetch calls a turn may make. Zero keeps the tool but spends nothing.",
  },
  maxSearches: {
    label: "Searches per turn",
    text: "websearch calls a turn may make. Zero keeps the tool but spends nothing.",
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
    text: "The size one visual may reach.",
  },
  visualSendBytes: {
    label: "Visual bytes per turn",
    text: "The size of all visuals in a turn.",
  },
  maxVisuals: {
    label: "Visuals per turn",
    text: "Tool calls a turn may draw.",
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
    text: "Room kept in the window. Reaching it ends tool work and answers. A chat then summarizes.",
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
    text: "Provider requests an automation may make updating its memory.",
  },
  runDeadlineMs: {
    label: "Run deadline",
    text: "How long an automation's run may take. An automation may set less.",
  },
  sendDeadlineMs: {
    label: "Chat deadline",
    text: "How long one chat turn may take, tools included.",
  },
  knowledgeFileBytes: {
    label: "File size",
    text: "Bytes one knowledge file may hold.",
  },
  knowledgeFiles: {
    label: "Files per project",
    text: "Knowledge files a project may hold.",
  },
  knowledgeProjectBytes: {
    label: "Base size",
    text: "Bytes a project's knowledge files may hold together.",
  },
  knowledgeVersions: {
    label: "Versions per file",
    text: "Past versions kept per file. Older ones go as a write lands.",
  },
  knowledgeHistoryBytes: {
    label: "History size",
    text: "Bytes of past versions a project keeps. The oldest go first.",
  },
  knowledgeHistoryDays: {
    label: "History days",
    text: "How long a deleted file's versions are kept.",
  },
  scratchBytes: {
    label: "Scratch size",
    text: "Bytes a session's scratch files may hold together.",
  },
  scratchFiles: {
    label: "Scratch files",
    text: "Scratch files a session may hold.",
  },
  scratchIdleDays: {
    label: "Scratch idle days",
    text: "How long an unused session scratch is kept.",
  },
  uploadBytes: {
    label: "Chat files size",
    text: "Bytes the files added to one chat may hold together.",
  },
  uploadFiles: {
    label: "Chat files",
    text: "Files one chat may hold.",
  },
  mcpKeptBytes: {
    label: "Kept MCP results size",
    text: "Bytes of MCP results kept for one chat past the result cut.",
  },
  mcpKeptFiles: {
    label: "Kept MCP files",
    text: "MCP results and resources kept for one chat.",
  },
  runsPerUser: {
    label: "Runs per user",
    text: "Runs one person may have going at once. A scheduled run waits for a free slot.",
  },
  runsRunning: {
    label: "Runs at once",
    text: "Runs the server may have going at once, every user counted.",
  },
};

// when a send carries a built-in, over its description
export const WHEN_WORDS: Record<ToolWhen, string> = {
  always: "Sent to every model that takes tools.",
  skills: "Sent when the agent has skills.",
  skillFiles: "Sent when one of the agent's skills has files.",
  mcpCatalog: "Sent when the agent's MCP tools go as a catalog.",
  memory: "Sent in every chat, over the project's memory.",
  knowledge:
    "Sent in every chat and run, over the project's knowledge base. Its tokens leave out the project's credentials.",
  web: "Sent while web access is on for the chat or the run.",
  webSearch: "Sent while web access is on and a search provider is chosen.",
};

// when a send carries a built-in's variant, the own-note text of
// memory_edit, the one tool that has one
export const VARIANT_WHEN_WORDS =
  "Sent in the step after a run that updates its own memory.";

export const NAMES_WORDS =
  "Shown without names. Each skill or tool name listed adds tokens.";

// the lines of a schema as the server renders it, for Show all
export function jsonLines(parameters: unknown): number {
  return JSON.stringify(parameters, null, 2).split("\n").length;
}

// the lines of the hosts box that hold something, for its count
export function hostsCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

// a card's tokens: every schema in it together
export function totalTokens(rows: { tokens: number }[]): number {
  return rows.reduce((n, row) => n + row.tokens, 0);
}

// the page's tabs, each an address
export type ToolsTab = "builtin" | "web" | "visuals" | "limits";

export const TOOLS_TABS: { tab: ToolsTab; label: string; href: string }[] = [
  { tab: "builtin", label: "Built-in", href: "/admin/tools" },
  { tab: "web", label: "Web", href: "/admin/tools/web" },
  { tab: "visuals", label: "Visuals", href: "/admin/tools/visuals" },
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
    case "days":
      return { word: "days", factor: 1 };
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
    return `${label} must be from ${show(row, row.min)} to ${show(row, row.max)}${unit}`;
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
  return `search-${provider}.key ${present ? "present" : "keyless"}`;
}

// what the search section says under the providers
export function searchLine(state: SearchState, mode: WebAccessMode): string {
  if (mode === "off") return "Web access is off. websearch is not offered.";
  if (state.provider === null) return "websearch is not offered.";
  const line = `websearch runs on ${state.provider}`;
  if (!state.keys[state.provider]) {
    const key = `search-${state.provider}.key`;
    return `${line} keyless. Add ${key} for a higher rate.`;
  }
  return `${line}.`;
}

// what the section says beside the box
export function hostsLine(hosts: readonly string[]): string {
  return hosts.length === 0
    ? "No CDNs. Visuals use inline code only."
    : "Visuals load scripts, styles and fonts only from these CDNs.";
}

// whether the list is the one a fresh instance starts with
export function defaultHosts(hosts: readonly string[]): boolean {
  return (
    hosts.length === DEFAULT_VISUAL_HOSTS.length &&
    DEFAULT_VISUAL_HOSTS.every((host, i) => hosts[i] === host)
  );
}

// the box as typed to the list a save sends, or the words for its field
export function hostsOf(text: string): { hosts: string[] } | { error: string } {
  const result = parseVisualHosts(text.split("\n"));
  if (!result.ok) {
    return {
      error:
        result.value === ""
          ? sentence(result.error)
          : `Line ${result.line}, ${result.value}, ${result.error}.`,
    };
  }
  return { hosts: result.hosts };
}

export function hostsFieldOf(message: string): "hosts" | undefined {
  return message.startsWith("hosts ") ? "hosts" : undefined;
}

// the first sentence of a description, for the row
export { firstSentence, tokensText } from "../../lib/format.ts";

// web access: the three modes in the card's head, and what each means
export const ACCESS_MODES: { value: WebAccessMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "all", label: "All domains" },
  { value: "listed", label: "Listed domains" },
];

export const ACCESS_WORDS: Record<WebAccessMode, string> = {
  off: "Agents cannot fetch pages, search the web or use curl.",
  all: "Agents fetch pages, search the web and use curl in bash, on any address this server reaches.",
  listed: "Agents fetch pages and use curl in bash, only on these hosts.",
};

export const DOMAINS_HINT =
  "One host per line. A subdomain needs its own line.";

// the box as typed to the list a save sends, or the words for its field
export function domainsOf(
  text: string,
): { domains: string[] } | { error: string } {
  const result = parseDomains(text.split("\n"));
  if (!result.ok) {
    return {
      error:
        result.value === ""
          ? sentence(result.error)
          : `Line ${result.line}, ${result.value}, ${result.error}.`,
    };
  }
  if (result.domains.length === 0) return { error: "List at least one host." };
  return { domains: result.domains };
}

// a refusal of the web row that names the list belongs to the box
export function domainsFieldOf(message: string): "domains" | undefined {
  return message.startsWith("domains ") || message.includes("host")
    ? "domains"
    : undefined;
}
