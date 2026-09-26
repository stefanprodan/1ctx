// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the agent routes, for admins, and of
// the signed-in user's favourite agent.

import type { AgentSummary } from "../contracts/agent.ts";
import type { AgentServer } from "../contracts/mcp.ts";
import type { Avatar, Effort, McpMode } from "../words.ts";

// GET /api/agents
export type AgentsResponse = { agents: AgentSummary[] };

// POST /api/agents and PATCH /api/agents/:id answer the row
export type AgentResponse = { agent: AgentSummary };
// GET and PUT /api/profile/agent, for any signed-in user: their
// favourite, null when they follow the default, the default's id, and
// every agent to pick from, oldest first
export type FavouriteAgentResponse = {
  agentId: string | null;
  defaultId: string | null;
  agents: { id: string; name: string; avatar: Avatar }[];
};

// PUT /api/profile/agent; null follows the default again
export type SetFavouriteAgentRequest = { agentId: string | null };

// the model is an id the provider's catalog lists
export type SaveAgentRequest = {
  name: string;
  avatar: Avatar;
  providerId: string;
  model: string;
  thinking: "on" | "off" | null;
  effort: Effort | null;
  prompt: string;
  // skill ids, at most MAX_SKILLS_PER_AGENT, empty allowed
  skills: string[];
  // the full set of servers, each with at least one side on, no repeat,
  // at most 50; an unknown id is a 400
  servers: AgentServer[];
  mcpMode: McpMode;
  // the OpenRouter endpoint tag tried first, from the model's endpoints;
  // absent or null lets OpenRouter route. Refused on another wire
  upstream?: string | null;
  // what the admin states for a model its catalog does not describe:
  // the window in tokens and whether it takes tools. Refused for a
  // model the catalog describes; a window is required with tools on
  contextLength?: number | null;
  tools?: boolean;
  // true makes it the default; false on the default takes the mark off,
  // so the first created is the default again; absent leaves the mark
  default?: boolean;
};
