// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the agent routes, all for admins.

import type { AgentSummary } from "../contracts/agent.ts";

// GET /api/agents
export type AgentsResponse = { agents: AgentSummary[] };

// POST /api/agents and PATCH /api/agents/:id answer the row
export type AgentResponse = { agent: AgentSummary };
// the model is an id the provider's catalog lists
export type SaveAgentRequest = {
  name: string;
  providerId: string;
  model: string;
};
