// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpProjects } from "../../../shared/api/mcp.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  McpChange,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import { classify, serverBlock } from "../../../shared/mcp.ts";
import { MCP_TIMEOUT_MS } from "../../../shared/words.ts";
import { ago, pluralCommas } from "../../lib/format.ts";
import { cutLines } from "../../lib/lines.ts";

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
    "projects",
  ]) {
    if (message.startsWith(field)) return field;
  }
  if (
    message.startsWith("a server with a key needs") ||
    message.startsWith("no such team project")
  ) {
    return "projects";
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
): AgentSummary[] => (serverId === "" ? [] : agents.filter((a) => a.mcp));

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

// where a server is offered, as a form picks it: "" until picked
export type Reach = "all" | "picked" | "";

export const REACH_OPTIONS: { value: Reach; label: string }[] = [
  { value: "all", label: "All projects" },
  { value: "picked", label: "Picked projects" },
];

export const reachOf = (server: Pick<McpServerSummary, "scope">): Reach =>
  server.scope === "all" ? "all" : "picked";

// a new server's start: a keyless one reaches every project, a keyed
// one nothing until the admin picks, so a key never reaches everyone by
// accident
export const reachForKey = (keyed: boolean): Reach => (keyed ? "" : "all");

export function projectsBody(
  reach: Reach,
  projectIds: readonly string[],
): McpProjects | undefined {
  if (reach === "all") return "all";
  return reach === "picked" ? [...projectIds] : undefined;
}

// the server's rule: a key needs all or at least one team project
export function projectsProblem(
  keyed: boolean,
  reach: Reach,
  projectIds: readonly string[],
): string | null {
  if (reach === "") return "Pick the projects";
  if (keyed && reach === "picked" && projectIds.length === 0) {
    return "A server with a key needs a project";
  }
  return null;
}

// under the Projects field: what a pick means, only where it is not
// plain from the rows; a keyed server with nothing picked gets the
// field's error instead
export function reachHint(
  reach: Reach,
  projectIds: readonly string[],
  keyed: boolean,
): string | undefined {
  if (reach === "all") return "Personal projects included.";
  if (reach === "" || keyed) return undefined;
  return projectIds.length === 0 ? "Offered in no project." : undefined;
}

export const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

// the list row: every project, how many, or none
export function scopeCount(
  server: Pick<McpServerSummary, "scope" | "projects">,
): string {
  if (server.scope === "all") return "All projects";
  const n = server.projects.length;
  return n === 0 ? "No projects" : pluralCommas(n, "project", "projects");
}
