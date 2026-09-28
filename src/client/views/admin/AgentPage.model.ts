// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AgentActivity,
  AgentImpactResponse,
  SaveAgentRequest,
} from "../../../shared/api/agents.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { ago, plural } from "../../lib/format.ts";
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
      ? plural(counts.servers, "MCP server", "MCP servers")
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

export function nameTaken(
  name: string,
  agents: AgentSummary[] | null,
  self: string,
): boolean {
  const n = name.trim();
  return agents?.some((a) => a.name === n && a.id !== self) ?? false;
}
