// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Response bodies of the directory routes: the lists of users, agents
// and deciders, and a page for each, open to every signed-in user.

import type { AgentSummary } from "../contracts/agent.ts";
import type { DeciderSummary } from "../contracts/decider.ts";
import type { DecisionId } from "../contracts/decision.ts";
import type { ProjectSummary } from "../contracts/project.ts";
import type { OfferedSkill } from "../contracts/skill.ts";
import type { DirectoryUser, UserSummary } from "../contracts/user.ts";
import type { DayUsage } from "./usage.ts";

// GET /api/directory/users: the enabled users by username, with the
// zone their local time is read in and no email
export type DirectoryUsersResponse = {
  users: (UserSummary & { tz: string })[];
};

// GET /api/directory/agents: the live agents by name, the model as its
// id alone
export type DirectoryAgentRow = Pick<
  AgentSummary,
  "id" | "name" | "avatar" | "default"
> & { model: string };
export type DirectoryAgentsResponse = { agents: DirectoryAgentRow[] };

// GET /api/directory/users/:username; the projects are the team
// projects the caller and the user are both members of
export type DirectoryUserResponse = {
  user: DirectoryUser;
  projects: ProjectSummary[];
};

// a skill the agent carries, with when its source was last fetched and
// how many files it holds, SKILL.md counted
export type DirectorySkill = OfferedSkill & {
  fetchedAt: number;
  files: number;
};

// a built-in tool a send would offer: the first sentence of its
// description, all the page draws, and the provider that answers it when
// an admin picked one (websearch's exa, firecrawl or tavily)
export type DirectoryTool = {
  name: string;
  description: string;
  provider: string | null;
};

// token counts in OpenAI's o200k_base encoding, an estimate for any
// other vendor: the system prompt, the skill bodies together (what
// loading every skill costs) and the tool schemas every request carries
export type DirectoryTokens = { prompt: number; skills: number; tools: number };

// an MCP server a send would offer the agent now: how many of its tools
// reach the model, when its list was last discovered and when a refresh
// last failed since, if one did
export type DirectoryMcpServer = {
  name: string;
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

// GET /api/directory/deciders: every decider by name, the model as its
// id, and the decisions it answers now: those naming it, and those
// naming none when it is the default, a turned-off one left out
export type DirectoryDeciderRow = Pick<
  DeciderSummary,
  "id" | "name" | "default" | "model"
> & { decisions: DecisionId[] };
export type DirectoryDecidersResponse = { deciders: DirectoryDeciderRow[] };

// a decider as every user sees it: no provider id
export type DirectoryDecider = Omit<DeciderSummary, "providerId">;

// GET /api/directory/deciders/:name; the provider's name and the
// decisions it answers now, as the list's row has them
export type DirectoryDeciderResponse = {
  decider: DirectoryDecider;
  provider: string;
  decisions: DecisionId[];
};

// a decider's day: its answers and their input tokens, since a decision
// has no output
export type DeciderDay = { answers: number; tokens: number };

// GET /api/directory/deciders/:name/days?tz=: the decider's answers in
// every project over the 53 ISO weeks in the caller's zone, Monday
// first, today last, an admin's Check not counted: usage is as long as
// days, zeros included, and total is its sum
export type DirectoryDeciderDaysResponse = {
  since: number;
  until: number;
  days: string[];
  total: DeciderDay;
  usage: DeciderDay[];
};
