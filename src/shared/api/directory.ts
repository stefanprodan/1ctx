// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Response bodies of the directory routes: a user's page and an
// agent's page, open to every signed-in user.

import type { AgentSummary } from "../contracts/agent.ts";
import type { ProjectSummary } from "../contracts/project.ts";
import type { OfferedSkill } from "../contracts/skill.ts";
import type { DirectoryUser } from "../contracts/user.ts";
import type { McpMode } from "../words.ts";

// GET /api/directory/users/:username; the projects are the team
// projects the caller and the user are both members of
export type DirectoryUserResponse = {
  user: DirectoryUser;
  projects: ProjectSummary[];
};

// a skill the agent carries, with when its source was last fetched
export type DirectorySkill = OfferedSkill & { fetchedAt: number };

// a built-in tool a send would offer, with the provider that answers
// it when an admin picked one (websearch's exa, firecrawl or tavily)
export type DirectoryTool = { name: string; provider: string | null };

// token counts in OpenAI's o200k_base encoding, an estimate for any
// other vendor: the system prompt, the skill bodies together (what
// loading every skill costs) and the tool schemas every request carries
export type DirectoryTokens = { prompt: number; skills: number; tools: number };

// an MCP server a send would offer the agent now, with the sides the
// agent may use and how many of its tools reach the model
export type DirectoryMcpServer = {
  name: string;
  read: boolean;
  write: boolean;
  tools: number;
};

// the agent's MCP: its mode, what a send resolves it to now, the
// offered servers, and the lean schemas' count against the cap that
// flips auto to the catalog
export type DirectoryMcp = {
  mode: McpMode;
  resolved: "all" | "catalog";
  servers: DirectoryMcpServer[];
  tokens: number;
  cap: number;
};

// GET /api/directory/agents/:name; the provider's name, the skills it
// carries, the built-in tools a send would offer it now, and its MCP
export type DirectoryAgentResponse = {
  agent: AgentSummary;
  provider: string;
  skills: DirectorySkill[];
  tools: DirectoryTool[];
  mcp: DirectoryMcp;
  tokens: DirectoryTokens;
};
