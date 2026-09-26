// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Response bodies of the directory routes: a user's page and an
// agent's page, open to every signed-in user.

import type { AgentSummary } from "../contracts/agent.ts";
import type { ProjectSummary } from "../contracts/project.ts";
import type { OfferedSkill } from "../contracts/skill.ts";
import type { DirectoryUser } from "../contracts/user.ts";
import type { DayUsage } from "./usage.ts";

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

// an MCP server a send would offer the agent now: the sides the agent
// may use, how many of its tools reach the model, when its list was
// last discovered and when a refresh last failed since, if one did
export type DirectoryMcpServer = {
  name: string;
  read: boolean;
  write: boolean;
  tools: number;
  checkedAt: number;
  refreshFailedAt: number | null;
};

// the agent's MCP: the offered servers and their lean schemas' count
export type DirectoryMcp = {
  servers: DirectoryMcpServer[];
  tokens: number;
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

// GET /api/directory/agents/:name/days?tz=: the agent's turns in every
// project over the 53 ISO weeks in the caller's zone, Monday first,
// today last, as one series: usage is as long as days, zeros included,
// and total counts a send once even when its rounds fall on two days
export type DirectoryAgentDaysResponse = {
  since: number;
  until: number;
  days: string[];
  total: DayUsage;
  usage: DayUsage[];
};

// GET /api/directory/users/:username/days: the user's actions in every
// project over the 53 ISO weeks in the user's own zone, never the
// caller's, Monday first, today last, as one series: the messages they
// wrote in chats, the chats and the manual runs they started, and one
// for each day they were signed in. usage is as long as days, zeros
// included, and total is its sum
export type DirectoryUserDaysResponse = {
  since: number;
  until: number;
  days: string[];
  total: number;
  usage: number[];
};
