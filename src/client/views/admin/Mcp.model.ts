// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpProjects } from "../../../shared/api/mcp.ts";
import type {
  McpChange,
  McpOn,
  McpServerSummary,
  McpSide,
} from "../../../shared/contracts/mcp.ts";
import { classify, serverBlock } from "../../../shared/mcp.ts";
import { MCP_TIMEOUT_MS } from "../../../shared/words.ts";
import { ago, pluralCommas } from "../../lib/format.ts";
import { cutLines } from "../../lib/lines.ts";
import { onCount, onWords } from "../directory/Directory.model.ts";

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
export type Offer = McpSide;

// a side's word: the server's switches, a personal grant, a project's
// choice
export const SIDE_WORDS: Record<McpSide, string> = {
  off: "Off",
  read: "Read",
  write: "Read and write",
};

// the server's own switches, as the Access card names them
export const CEILING_LABEL = "Most a project may use";

export const OFFER_OPTIONS: { value: Offer; label: string }[] = (
  ["off", "read", "write"] as const
).map((value) => ({ value, label: SIDE_WORDS[value] }));

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
    "personal",
  ]) {
    if (message.startsWith(field)) return field;
  }
  if (message.startsWith("a server with a key needs personal")) {
    return "personal";
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

// where a server is on, as the directory says it
export const whereOn = (on: McpOn): string =>
  onWords(
    on.projects.map((p) => p.name),
    on.personal,
  );

// the agent's MCP tab: counted, the names on hover
export const whereOnCount = (on: McpOn): string =>
  onCount(on.projects.length, on.personal);

const isOn = (on: McpOn) => on.projects.length > 0 || on.personal > 0;

// the delete's line and its ask say the same: what loses the server
export function deleteLine(on: McpOn): string {
  return isOn(on) ? `On in ${whereOn(on)}.` : "On in no project.";
}

export function deleteAsk(name: string, on: McpOn): string {
  return isOn(on)
    ? `Delete ${name}? It is on in ${whereOn(on)}.`
    : `Delete ${name}?`;
}

// where a server is offered, as a form picks it: "" until picked
export type Reach = "all" | "picked" | "";

export const REACH_OPTIONS: { value: Reach; label: string }[] = [
  { value: "all", label: "All team projects" },
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
  if (reach !== "picked" || keyed) return undefined;
  return projectIds.length === 0 ? "Offered in no team project." : undefined;
}

// the most a personal project may choose, as a form picks it: "" until
// picked
export type Personal = McpSide | "";

// a new server's start: a keyless one reads, a keyed one nothing until
// the admin picks, since there every user acts as the key's owner
export const personalForKey = (keyed: boolean): Personal =>
  keyed ? "" : "read";

export const personalProblem = (personal: Personal): string | null =>
  personal === "" ? "Pick what personal projects get" : null;

// under the Personal projects field: what a keyed grant means
export function personalHint(
  personal: Personal,
  keyed: boolean,
): string | undefined {
  if (!keyed || personal === "" || personal === "off") return undefined;
  return "Every user acts as the key's owner in their own project.";
}

export const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

// the list row: every team, how many, or none, then the personal
// grant when it is not off
export function grantWords(
  server: Pick<McpServerSummary, "scope" | "projects" | "personal">,
): string {
  const n = server.projects.length;
  const teams =
    server.scope === "all"
      ? "All teams"
      : n === 0
        ? "No projects"
        : pluralCommas(n, "project", "projects");
  return server.personal === "off"
    ? teams
    : `${teams} · personal ${SIDE_WORDS[server.personal].toLowerCase()}`;
}
