// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The MCP page's model, tested without a DOM: the head's words, the
// change and failure lines, the pattern fields to lists and back, the
// live split and the patterns matching nothing, the timeout in
// seconds, the key options, the instructions box trimmed to its first
// lines, and the agent form's preview of what a send would carry from
// the rows loaded.

import type {
  AgentServer,
  McpChange,
  McpServerSummary,
  McpToolSummary,
} from "../../../shared/contracts/mcp.ts";
import {
  classify,
  MAX_INSTRUCTIONS_BLOCK,
  offeredServers,
  type Patterns,
  promptSnapshot,
  serverBlock,
  unmatched,
} from "../../../shared/mcp.ts";
import {
  MCP_KEY_PREFIX,
  MCP_MODES,
  MCP_TIMEOUT_MS,
  type McpMode,
} from "../../../shared/words.ts";
import { ago } from "../../lib/format.ts";
import type { Option } from "../../ui/Select.model.ts";

export const NO_KEY = "";

// the head under the name: the tools and the last good check, or the
// failure in red
export function metaLine(
  server: McpServerSummary,
  now: number,
): { text: string; bad: boolean } {
  if (server.refreshError !== null && server.refreshFailedAt !== null) {
    return {
      text: `refresh failed ${ago(server.refreshFailedAt, now)}`,
      bad: true,
    };
  }
  const n = server.tools.length;
  return {
    text: `${n} ${n === 1 ? "tool" : "tools"} · checked ${ago(server.checkedAt, now)}`,
    bad: false,
  };
}

// what the last refresh changed, as one line
export function changeLine(change: McpChange | null, now: number): string {
  if (change === null) return "";
  const parts: string[] = [];
  const word = (n: number, what: string) =>
    `${n} ${n === 1 ? "tool" : "tools"} ${what}`;
  if (change.added.length > 0) parts.push(word(change.added.length, "added"));
  if (change.removed.length > 0) {
    parts.push(
      parts.length === 0
        ? word(change.removed.length, "removed")
        : `${change.removed.length} removed`,
    );
  }
  if (change.changed.length > 0) {
    parts.push(
      parts.length === 0
        ? word(change.changed.length, "changed")
        : `${change.changed.length} changed`,
    );
  }
  if (change.instructions) parts.push("instructions changed");
  if (parts.length === 0) return "";
  return `${ago(change.at, now)}: ${parts.join(", ")}`;
}

// a failed refresh keeps the last good list; the line says how old
export function servedLine(server: McpServerSummary, now: number): string {
  return `serving the list from ${ago(server.checkedAt, now)}`;
}

export function patternText(list: string[]): string {
  return list.join("\n");
}

export function endpointDirty(
  server: McpServerSummary,
  url: string,
  keyName: string,
): boolean {
  const key = keyName === NO_KEY ? null : keyName;
  return url.trim() !== server.url || key !== server.keyName;
}

export function settingsDirty(
  server: McpServerSummary,
  draft: {
    read: boolean;
    write: boolean;
    instructionsOn: boolean;
    timeout: string;
    patterns: Patterns;
  },
): boolean {
  return (
    draft.read !== server.read ||
    draft.write !== server.write ||
    draft.instructionsOn !== server.instructionsOn ||
    timeoutMs(draft.timeout) !== server.timeoutMs ||
    patternText(draft.patterns.read) !== patternText(server.readPatterns) ||
    patternText(draft.patterns.write) !== patternText(server.writePatterns) ||
    patternText(draft.patterns.excluded) !==
      patternText(server.excludedPatterns)
  );
}

export function patternsOf(server: McpServerSummary): Patterns {
  return {
    read: server.readPatterns,
    write: server.writePatterns,
    excluded: server.excludedPatterns,
  };
}

export type ToolGroups = {
  read: McpToolSummary[];
  write: McpToolSummary[];
  excluded: McpToolSummary[];
  // with the reason: the stored one, or the wire name
  unusable: { tool: McpToolSummary; reason: string }[];
};

// the four groups as the page computes them live from the fields
export function toolGroups(
  server: McpServerSummary,
  patterns: Patterns,
): ToolGroups {
  const sides = classify(server.name, server.tools, patterns);
  const groups: ToolGroups = {
    read: [],
    write: [],
    excluded: [],
    unusable: [],
  };
  for (const tool of server.tools) {
    const side = sides.get(tool.name);
    if (side === "unusable") {
      groups.unusable.push({
        tool,
        reason: tool.unusable ?? "unusable name",
      });
    } else if (side === "read") groups.read.push(tool);
    else if (side === "write") groups.write.push(tool);
    else groups.excluded.push(tool);
  }
  return groups;
}

// the patterns of one field matching no discovered tool
export function unmatchedIn(
  server: McpServerSummary,
  list: string[],
): string[] {
  const names = server.tools.map((t) => t.name);
  return unmatched(names, { read: list, write: [], excluded: [] });
}

export function unmatchedLine(patterns: string[]): string {
  if (patterns.length === 0) return "";
  return `${patterns.length === 1 ? "matches" : "match"} no tool: ${patterns.join(", ")}`;
}

// the timeout field holds seconds; empty is the limits' value
export function timeoutText(ms: number | null): string {
  return ms === null ? "" : String(ms / 1000);
}

export function timeoutProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds * 1000)) {
    return "A number of seconds";
  }
  const ms = Math.round(seconds * 1000);
  if (ms < MCP_TIMEOUT_MS.min || ms > MCP_TIMEOUT_MS.max) {
    return `${MCP_TIMEOUT_MS.min / 1000} to ${MCP_TIMEOUT_MS.max / 1000} seconds`;
  }
  return null;
}

export function timeoutMs(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Math.round(Number(trimmed) * 1000);
}

// the key select: No key first, the mcp- files, and the row's own name
// when its file is gone, marked, so the row still shows what it names
export function keyOptions(keys: string[], current: string | null): Option[] {
  const options: Option[] = [{ value: NO_KEY, label: "No key" }];
  for (const key of keys) options.push({ value: key, label: key });
  if (current !== null && !keys.includes(current)) {
    options.push({ value: current, label: current, detail: "missing" });
  }
  return options;
}

export const KEY_HINT = `A key file is ${MCP_KEY_PREFIX}<name>.key in the secrets directory, sent as a bearer token.`;

export const MODE_OPTIONS: { value: McpMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "all", label: "All schemas" },
  { value: "catalog", label: "Catalog" },
];

export const MODE_HINT: Record<McpMode, string> = {
  auto: "Every tool schema goes to the model until they pass the token cap, then a catalog with two tools.",
  all: "Every offered tool schema goes to the model on every request.",
  catalog:
    "The model gets one line per tool and asks for a schema before calling it.",
};

export function isModeValue(value: string): value is McpMode {
  return (MCP_MODES as readonly string[]).includes(value);
}

// the instructions box: the block as the prompt carries it, its first
// lines when folded; a block of INSTRUCTIONS_LINES or fewer has no toggle
export const INSTRUCTIONS_LINES = 12;

export function instructionsBox(
  name: string,
  instructions: string,
  expanded: boolean,
): { text: string; canToggle: boolean; count: number } {
  const block = serverBlock(name, instructions).replace(/\n$/, "");
  const lines = block.split("\n");
  const canToggle = lines.length > INSTRUCTIONS_LINES;
  return {
    text:
      canToggle && !expanded
        ? lines.slice(0, INSTRUCTIONS_LINES).join("\n")
        : block,
    canToggle,
    count: block.length,
  };
}

export function characters(n: number): string {
  return `${n.toLocaleString("en-US")} characters`;
}

// the agent form's preview from the rows loaded: what the prompt would
// carry, the servers a cap leaves out, and the block to view
export function promptPreview(
  rows: McpServerSummary[],
  links: AgentServer[],
): {
  line: string;
  warnings: string[];
  text: string;
} {
  const offered = offeredServers(rows, links);
  const snapshot = promptSnapshot(offered, () => "");
  const warnings: string[] = [];
  for (const name of snapshot.leftForInstructions) {
    warnings.push(
      `${name} left out: over the ${MAX_INSTRUCTIONS_BLOCK.toLocaleString("en-US")} cap`,
    );
  }
  for (const name of snapshot.leftForSchemas) {
    warnings.push(`${name} left out: its tools are over the 1 MB cap`);
  }
  const included = new Set(snapshot.included);
  const from = offered
    .filter(
      (s) =>
        included.has(s.name) &&
        s.instructions !== null &&
        !snapshot.leftForInstructions.includes(s.name),
    )
    .map((s) => s.name);
  const line =
    snapshot.text === ""
      ? ""
      : `Instructions in the prompt: ${snapshot.text.length.toLocaleString("en-US")} of ${MAX_INSTRUCTIONS_BLOCK.toLocaleString("en-US")} characters, from ${from.join(", ")}`;
  return { line, warnings, text: snapshot.text };
}

// which field of the form a refusal names
export function mcpFieldOf(message: string): string | undefined {
  for (const field of [
    "name",
    "url",
    "keyName",
    "timeoutMs",
    "readPatterns",
    "writePatterns",
    "excludedPatterns",
  ]) {
    if (message.startsWith(field)) return field;
  }
  if (message.startsWith("an MCP server named")) return "name";
  return undefined;
}
