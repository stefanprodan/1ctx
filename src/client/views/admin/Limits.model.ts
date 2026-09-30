// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { LimitName } from "../../../shared/words.ts";
import { pluralCommas } from "../../lib/format.ts";

export const LIMIT_WORDS: Record<LimitName, { label: string; text: string }> = {
  rounds: {
    label: "Rounds",
    text: "Provider requests in one turn, the answer included.",
  },
  callsPerRound: {
    label: "Calls per round",
    text: "Tool calls one round may run in parallel.",
  },
  callsPerSend: {
    label: "Calls per turn",
    text: "Tool calls across a turn's rounds.",
  },
  toolMs: {
    label: "Tool time",
    text: "Time in tools over a turn, every round summed.",
  },
  resultBytes: {
    label: "Result bytes",
    text: "Tool results stored over a turn.",
  },
  toolWorkTokens: {
    label: "Tool-work tokens",
    text: "Tokens a turn may spend on tools before it answers.",
  },
  callTimeoutMs: {
    label: "Call timeout",
    text: "How long one tool call may run.",
  },
  resultCut: {
    label: "Result cut",
    text: "What the model reads of one result.",
  },
  maxBashCalls: {
    label: "Bash calls per turn",
    text: "bash calls in one turn. More are refused.",
  },
  maxFetches: {
    label: "Fetches per turn",
    text: "webfetch calls in one turn. More are refused.",
  },
  maxSearches: {
    label: "Searches per turn",
    text: "websearch calls in one turn. More are refused.",
  },
  fetchBodyBytes: {
    label: "Response size",
    text: "Largest answer from webfetch, curl or an MCP tool.",
  },
  searchBodyBytes: {
    label: "Search body",
    text: "The largest answer a search provider may return.",
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
    text: "How long one webfetch or curl request may take.",
  },
  searchDeadlineMs: {
    label: "Search deadline",
    text: "How long one search request may take.",
  },
  contextReserve: {
    label: "Context reserve",
    text: "Room kept free in the context window.",
  },
  summaryMaxTokens: {
    label: "Summary tokens",
    text: "The longest a chat summary may be.",
  },
  memoryPhaseMs: {
    label: "Memory time",
    text: "How long a run may spend updating memory.",
  },
  memoryPhaseRounds: {
    label: "Memory rounds",
    text: "Provider requests a run may make updating memory.",
  },
  runDeadlineMs: {
    label: "Run deadline",
    text: "How long one run may take.",
  },
  sendDeadlineMs: {
    label: "Chat deadline",
    text: "How long one chat turn may take.",
  },
  knowledgeFileBytes: {
    label: "File size",
    text: "The largest a file may be.",
  },
  knowledgeFiles: {
    label: "Files per project",
    text: "Files one project may hold.",
  },
  knowledgeProjectBytes: {
    label: "Base size",
    text: "A project's files together.",
  },
  knowledgeVersions: {
    label: "Versions per file",
    text: "Past versions kept of one file.",
  },
  knowledgeHistoryBytes: {
    label: "History size",
    text: "Past versions a project keeps, oldest dropped first.",
  },
  knowledgeHistoryDays: {
    label: "History days",
    text: "How long a deleted file's versions stay.",
  },
  scratchBytes: {
    label: "Size",
    text: "A session's scratch files together.",
  },
  scratchFiles: {
    label: "Files",
    text: "Scratch files one session may hold.",
  },
  scratchIdleDays: {
    label: "Idle days",
    text: "How long an unused scratch is kept.",
  },
  uploadBytes: {
    label: "Chat files size",
    text: "The files added to one chat together.",
  },
  uploadFiles: {
    label: "Chat files",
    text: "Files one chat may hold.",
  },
  mcpKeptBytes: {
    label: "Size",
    text: "The results one chat keeps together.",
  },
  mcpKeptFiles: {
    label: "Files",
    text: "Results and resources one chat keeps.",
  },
  sendsPerUser: {
    label: "Per user",
    text: "Chats and runs one user has going at once. Scheduled runs are not counted.",
  },
  sendsPerProject: {
    label: "Per project",
    text: "Chats and runs going at once in one project.",
  },
  sendsRunning: {
    label: "At once",
    text: "Chats and runs going at once, every project counted.",
  },
  queuedPerUser: {
    label: "Waiting per user",
    text: "Messages one user may have waiting, not sent ones included.",
  },
  queuedMinutes: {
    label: "Waiting time",
    text: "How long a message may wait for the reply to end.",
  },
  archiveIdleDays: {
    label: "Archive idle chats",
    text: "Days without a turn before a chat is archived.",
  },
  archivedDeleteDays: {
    label: "Delete archived chats",
    text: "Days an archived chat is kept.",
  },
};

type Display = { word: string; factor: number };

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
    case "minutes":
      return { word: "min", factor: 1 };
    default:
      return { word: "", factor: 1 };
  }
}

// milliseconds and binary byte factors have finite decimal forms, so
// the full number keeps every integer the server accepts through a save
export function show(row: LimitRow, value: number): string {
  return String(value / displayOf(row).factor);
}

export function read(row: LimitRow, text: string): number | null {
  const t = text.trim();
  if (t === "" || !/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * displayOf(row).factor);
}

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

export function dirty(rows: LimitRow[], draft: Record<string, string>) {
  return rows.some((row) => read(row, draft[row.name] ?? "") !== row.value);
}

export function defaultLine(row: LimitRow): string {
  const { word } = displayOf(row);
  return `default ${show(row, row.default)}${word === "" ? "" : ` ${word}`}`;
}
