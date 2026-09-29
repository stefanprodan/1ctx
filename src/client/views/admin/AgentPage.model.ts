// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AgentActivity,
  AgentImpactResponse,
  SaveAgentRequest,
} from "../../../shared/api/agents.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  AgentServer,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import {
  MAX_INSTRUCTIONS_BLOCK,
  offeredServers,
  promptSnapshot,
} from "../../../shared/mcp.ts";
import { MCP_MODES, type McpMode } from "../../../shared/words.ts";
import { ago, commas, plural } from "../../lib/format.ts";
import { agentFieldOf, listed, statedFields } from "./Agents.model.ts";

// a refusal lands on a field only when the card draws it, else it is
// the card's notice
export const cardFieldOf =
  (fields: readonly string[]) =>
  (message: string): string | undefined => {
    const field = agentFieldOf(message);
    return field !== undefined && fields.includes(field) ? field : undefined;
  };

type Rows = { id: string }[] | null;

// the route takes the whole agent: the saved one with the card's fields
// over it. An undescribed model re-sends its stated window and tools, which
// go only with the model they were stated for; a deleted skill or server
// drops, or the server refuses its id
export function cardBody(
  agent: AgentSummary,
  change: Partial<SaveAgentRequest>,
  rows: { skills: Rows; servers: Rows },
): SaveAgentRequest {
  const body: SaveAgentRequest = {
    name: agent.name,
    avatar: agent.avatar,
    providerId: agent.providerId,
    model: agent.model.id,
    thinking: agent.thinking,
    effort: agent.effort,
    prompt: agent.prompt,
    skills: listed(agent.skills, (id) => id, rows.skills),
    servers: listed(agent.servers, (s) => s.serverId, rows.servers),
    mcpMode: agent.mcpMode,
    upstream: agent.upstream,
    ...statedFields(
      agent.model,
      agent.model.contextLength?.toString() ?? "",
      agent.model.tools,
    ),
    ...change,
  };
  if (change.model !== undefined && change.contextLength === undefined) {
    delete body.contextLength;
    delete body.tools;
  }
  return body;
}

export function lastUse(
  activity: AgentActivity | undefined,
  now: number,
): { text: string; running: boolean } {
  if (activity === undefined) return { text: "never ran", running: false };
  if (activity.running) return { text: "running", running: true };
  return { text: `ran ${ago(activity.lastAt, now)}`, running: false };
}

type Refreshed = { id: string; refreshFailedAt: number | null };

export function failing(
  agent: Pick<AgentSummary, "servers" | "skills">,
  servers: Refreshed[] | null,
  skills: Refreshed[] | null,
): { servers: number; skills: number } {
  const bad = (rows: Refreshed[] | null, id: string) =>
    rows?.some((r) => r.id === id && r.refreshFailedAt !== null) ?? false;
  return {
    servers: agent.servers.filter((s) => bad(servers, s.serverId)).length,
    skills: agent.skills.filter((id) => bad(skills, id)).length,
  };
}

export function failingLine(counts: { servers: number; skills: number }) {
  const parts = [
    counts.servers > 0
      ? plural(counts.servers, "MCP Server", "MCP Servers")
      : "",
    counts.skills > 0 ? plural(counts.skills, "skill") : "",
  ].filter((part) => part !== "");
  return parts.length === 0 ? "" : `${parts.join(", ")} failing`;
}

export function deleteLine(impact: AgentImpactResponse | null): string {
  if (impact === null) return "This cannot be undone.";
  const { chats, automations, running } = impact;
  const tasks = plural(automations, "scheduled task");
  const first =
    chats > 0 && automations > 0
      ? `Archives its ${plural(chats, "chat")} and pauses ${tasks}.`
      : chats > 0
        ? `Archives its ${plural(chats, "chat")}.`
        : automations > 0
          ? `Pauses ${tasks}.`
          : "";
  const stops = running > 0 ? `Stops the ${running} running now.` : "";
  return [first, stops, "This cannot be undone."]
    .filter((part) => part !== "")
    .join(" ");
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
