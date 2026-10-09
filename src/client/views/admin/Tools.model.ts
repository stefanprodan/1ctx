// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ToolWhen } from "../../../shared/contracts/tool.ts";
import { sentence } from "../../lib/format.ts";

export const WHEN_WORDS: Record<ToolWhen, string> = {
  always: "Sent to every model that takes tools.",
  skills: "Sent when the agent has skills.",
  skillFiles: "Sent when one of the agent's skills has files.",
  mcpCatalog: "Sent when the agent's MCP tools go as a catalog.",
  memory: "Sent in every chat, over the project's memory.",
  runs: "Sent alone in a step after a task run whose agent may mark it as needing attention.",
  knowledge:
    "Sent in every chat and run, over the project's knowledge base. Its tokens leave out the project's credentials.",
  web: "Sent while web access is on for the chat or the run.",
  webSearch: "Sent while web access is on and a search provider is chosen.",
};

// memory_edit's own-note text, the one variant
export const VARIANT_WHEN_WORDS =
  "Sent in the step after a run that updates its own memory.";

export function jsonLines(parameters: unknown): number {
  return JSON.stringify(parameters, null, 2).split("\n").length;
}

export function hostsCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

export function totalTokens(rows: { tokens: number }[]): number {
  return rows.reduce((n, row) => n + row.tokens, 0);
}

// an empty value: the list as a whole is refused
export function lineError(result: {
  line: number;
  value: string;
  error: string;
}): string {
  return result.value === ""
    ? sentence(result.error)
    : `Line ${result.line}, ${result.value}, ${result.error}.`;
}
