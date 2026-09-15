// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpDigest } from "../../shared/mcp.ts";

export const MAX_CHANGE_NAMES = 20;
export const MAX_CHANGE_NOTE = 4000;
const LEAD = "Since your last turn in this chat, these MCP tools changed:";
const END = "Do not call a removed tool.";

function changedNames(
  previous: Record<string, string>,
  current: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const before = new Set(Object.keys(previous));
  const after = new Set(Object.keys(current));
  return {
    added: [...after].filter((name) => !before.has(name)).sort(),
    removed: [...before].filter((name) => !after.has(name)).sort(),
    changed: [...after]
      .filter((name) => before.has(name) && previous[name] !== current[name])
      .sort(),
  };
}

function names(label: string, values: string[]): string {
  if (values.length === 0) return "";
  const shown = values.slice(0, MAX_CHANGE_NAMES);
  const more = values.length - shown.length;
  return `${label} ${shown.join(", ")}${more === 0 ? "" : ` and ${more} more`}`;
}

function line(
  server: string,
  previous: McpDigest[string] | undefined,
  current: McpDigest[string] | undefined,
): string | null {
  if (previous === undefined) return `- ${server}: now available`;
  if (current === undefined) return `- ${server}: no longer available`;
  const tools = changedNames(previous.tools, current.tools);
  const parts = [
    names("added", tools.added),
    names("removed", tools.removed),
    names("changed", tools.changed),
  ].filter((part) => part !== "");
  if (previous.instructions !== current.instructions) {
    parts.push("its instructions changed");
  }
  return parts.length === 0 ? null : `- ${server}: ${parts.join("; ")}`;
}

export function changeNote(
  previous: McpDigest | null,
  current: McpDigest,
): string {
  if (previous === null) return "";
  const servers = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const lines = [...servers].sort().flatMap((server) => {
    const value = line(server, previous[server], current[server]);
    return value === null ? [] : [value];
  });
  if (lines.length === 0) return "";
  const note = `${LEAD}\n${lines.join("\n")}\n${END}`;
  if (note.length <= MAX_CHANGE_NOTE) return note;
  const suffix = "\nand more changes";
  return `${note.slice(0, MAX_CHANGE_NOTE - suffix.length)}${suffix}`;
}
