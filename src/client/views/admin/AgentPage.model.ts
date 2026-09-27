// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Agents list and an agent's page decide without a DOM: the
// body a card's save sends (the saved agent with only that card's
// fields changed, since the route takes the whole agent), when an agent
// last ran, what of it is failing, and the words of its Delete card.

import type {
  AgentActivity,
  AgentImpactResponse,
  SaveAgentRequest,
} from "../../../shared/api/agents.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { ago, plural } from "../../lib/format.ts";
import { agentFieldOf, listed, statedFields } from "./Agents.model.ts";

// a card's refusal lands on a field only when the card draws it; any
// other, the catalog no longer listing the model on a rename, is the
// card's notice
export const cardFieldOf =
  (fields: readonly string[]) =>
  (message: string): string | undefined => {
    const field = agentFieldOf(message);
    return field !== undefined && fields.includes(field) ? field : undefined;
  };

// the agent as saved, as a save's body: a model the catalog does not
// describe carries its stated window and tools again, or the save
// would lose them
export function savedBody(agent: AgentSummary): SaveAgentRequest {
  return {
    name: agent.name,
    avatar: agent.avatar,
    providerId: agent.providerId,
    model: agent.model.id,
    thinking: agent.thinking,
    effort: agent.effort,
    prompt: agent.prompt,
    skills: agent.skills,
    servers: agent.servers,
    mcpMode: agent.mcpMode,
    upstream: agent.upstream,
    ...statedFields(
      agent.model,
      agent.model.contextLength?.toString() ?? "",
      agent.model.tools,
    ),
  };
}

type Rows = { id: string }[] | null;

// a card's save: the saved agent with the card's fields over it; the
// stated window and tools go only with the model they were stated for,
// and a skill or a server deleted since the page loaded drops out, or
// the server would refuse the id
export function cardBody(
  agent: AgentSummary,
  change: Partial<SaveAgentRequest>,
  rows: { skills: Rows; servers: Rows },
): SaveAgentRequest {
  const saved = savedBody(agent);
  const body = {
    ...saved,
    skills: listed(saved.skills, (id) => id, rows.skills),
    servers: listed(saved.servers, (s) => s.serverId, rows.servers),
    ...change,
  };
  if (change.model !== undefined && change.contextLength === undefined) {
    delete body.contextLength;
    delete body.tools;
  }
  return body;
}

// when the agent last ran, by anyone: "running" while a turn or a run
// is in flight, "ran 12m ago", or "never ran"
export function lastUse(
  activity: AgentActivity | undefined,
  now: number,
): { text: string; running: boolean } {
  if (activity === undefined) return { text: "never ran", running: false };
  if (activity.running) return { text: "running", running: true };
  return { text: `ran ${ago(activity.lastAt, now)}`, running: false };
}

type Refreshed = { id: string; refreshFailedAt: number | null };

// the servers and skills of the agent whose last refresh failed
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

// "1 MCP server failing", "5 MCP servers, 3 skills failing", or empty
export function failingLine(counts: { servers: number; skills: number }) {
  const parts = [
    counts.servers > 0
      ? plural(counts.servers, "MCP server", "MCP servers")
      : "",
    counts.skills > 0 ? plural(counts.skills, "skill") : "",
  ].filter((part) => part !== "");
  return parts.length === 0 ? "" : `${parts.join(", ")} failing`;
}

// the Delete card's line: the parts that apply, what runs now, then
// that it is for good
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

// a name another agent holds, as the list has it
export function nameTaken(
  name: string,
  agents: AgentSummary[] | null,
  self: string,
): boolean {
  const n = name.trim();
  return agents?.some((a) => a.name === n && a.id !== self) ?? false;
}
