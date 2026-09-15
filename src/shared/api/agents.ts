// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the agent routes, all for admins.

import type { AgentSummary } from "../contracts/agent.ts";
import type { AgentServer } from "../contracts/mcp.ts";
import type { Avatar, Effort, McpMode } from "../words.ts";

// GET /api/agents
export type AgentsResponse = { agents: AgentSummary[] };

// POST /api/agents and PATCH /api/agents/:id answer the row
export type AgentResponse = { agent: AgentSummary };
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
};
