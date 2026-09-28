// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  AgentServer,
  McpChange,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import {
  classify,
  MAX_INSTRUCTIONS_BLOCK,
  offeredServers,
  promptSnapshot,
  serverBlock,
} from "../../../shared/mcp.ts";
import {
  MCP_MODES,
  MCP_TIMEOUT_MS,
  type McpMode,
} from "../../../shared/words.ts";
import { ago, commas, plural, pluralCommas } from "../../lib/format.ts";
import { cutLines } from "../../lib/lines.ts";

export function changeLine(change: McpChange | null, now: number): string {
  if (change === null) return "";
  const parts: string[] = [];
  const word = (n: number, what: string) => `${plural(n, "tool")} ${what}`;
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

// empty is the limits' value
export function timeoutText(ms: number | null): string {
  return ms === null ? "" : String(ms / 1000);
}

export function timeoutProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds * 1000)) {
    return "The call timeout needs a number of seconds";
  }
  const ms = Math.round(seconds * 1000);
  if (ms < MCP_TIMEOUT_MS.min || ms > MCP_TIMEOUT_MS.max) {
    return `The call timeout must be from ${MCP_TIMEOUT_MS.min / 1000} to ${MCP_TIMEOUT_MS.max / 1000} seconds`;
  }
  return null;
}

export function timeoutMs(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Math.round(Number(trimmed) * 1000);
}

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

const INSTRUCTIONS_LINES = 12;

export function instructionsBox(
  name: string,
  instructions: string,
  expanded: boolean,
): { text: string; cut: boolean; count: number; lines: number } {
  const block = serverBlock(name, instructions).replace(/\n$/, "");
  return {
    ...cutLines(block, INSTRUCTIONS_LINES, expanded),
    count: block.length,
  };
}

export function instructionsLine(on: boolean): string {
  return on
    ? "Agents get these instructions in their system prompt."
    : "Agents do not get these instructions.";
}

export function promptPreview(
  rows: McpServerSummary[],
  links: AgentServer[],
): {
  line: string;
  warnings: string[];
  text: string;
  count: number;
  from: string[];
} {
  const offered = offeredServers(rows, links);
  const snapshot = promptSnapshot(offered, () => "");
  const warnings: string[] = [];
  for (const name of snapshot.leftForInstructions) {
    warnings.push(
      `${name} left out: over the ${commas(MAX_INSTRUCTIONS_BLOCK)} cap`,
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
      : `Instructions in the prompt: ${commas(snapshot.text.length)} of ${commas(MAX_INSTRUCTIONS_BLOCK)} characters, from ${from.join(", ")}`;
  return {
    line,
    warnings,
    text: snapshot.text,
    count: snapshot.text.length,
    from,
  };
}

// write alone has no option
export type Offer = "off" | "read" | "write";

export const OFFER_OPTIONS: { value: Offer; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
];

export function offerOf(read: boolean, write: boolean): Offer {
  if (write) return "write";
  return read ? "read" : "off";
}

export function offerSides(offer: Offer): { read: boolean; write: boolean } {
  return { read: offer !== "off", write: offer === "write" };
}

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
  // a failed discovery is the endpoint's: the key or the address
  if (message.startsWith("the MCP server refused the key")) return "keyName";
  if (message.startsWith("the MCP server is refreshing")) return undefined;
  if (/^(the MCP server|MCP request)\b/.test(message)) return "url";
  return undefined;
}

export const usersOf = (
  agents: readonly AgentSummary[],
  serverId: string,
): AgentSummary[] =>
  agents.filter((a) => a.servers.some((s) => s.serverId === serverId));

export function sidesLine(server: McpServerSummary): string {
  const sides = classify(server.name, server.tools, {
    read: server.readPatterns,
    write: server.writePatterns,
    excluded: server.excludedPatterns,
  });
  let read = 0;
  let write = 0;
  for (const side of sides.values()) {
    if (side === "read") read++;
    else if (side === "write") write++;
  }
  return [
    server.read ? `${read} read` : "read off",
    server.write ? `${write} write` : "write off",
  ].join(" · ");
}

export function deleteLine(users: number): string {
  if (users === 0) return "No agent uses it.";
  return `${pluralCommas(users, "agent uses", "agents use")} it. Remove it from ${
    users === 1 ? "that agent" : "them"
  } first.`;
}
