// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Agents: a name, an avatar, a provider and a model, and the system
// prompt. The MCP capability owns the agent-to-server rows.

import type { AgentServer } from "../../shared/contracts/mcp.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import {
  directoryRoutes,
  type SkillsListPort,
  type ToolsPort,
  type UsagePort,
} from "./directory.ts";
import {
  type AccessPort,
  type AutomationsPort,
  type CapabilitiesPort,
  type CredentialsPort,
  type McpPort,
  type ProvidersPort,
  type ReposPort,
  type RunnerPort,
  routes,
  type SessionsPort,
  type SkillsPort,
} from "./routes.ts";
import { type PicksPort, startingRoutes } from "./starting.ts";
import { type AgentRow, AgentStore } from "./store.ts";

export {
  MAX_SERVERS_PER_AGENT,
  parseEffort,
  parsePrompt,
  parseThinking,
} from "./parse.ts";
export { type AgentRow, AgentStore } from "./store.ts";

export type AgentsDeps = {
  db: Db;
  clock: Clock;
  providers: ProvidersPort;
  skills: SkillsPort & SkillsListPort & { assigned(agentId: string): string[] };
  mcp: McpPort & { agentServers(agentId: string): AgentServer[] };
  tools: ToolsPort & CapabilitiesPort;
  credentials: CredentialsPort;
  repos: ReposPort;
  access: AccessPort;
  sessions: () => SessionsPort;
  automations: () => AutomationsPort;
  runner: () => RunnerPort;
  usage: UsagePort;
  users: PicksPort & { clearAgent(agentId: string): void };
};

export type Agents = {
  store: AgentStore;
  byId(id: string): AgentRow | null;
  usesProvider(providerId: string): boolean;
  routes: RouteDescriptor[];
};

export function agentsArea(deps: AgentsDeps): Agents {
  const store = new AgentStore(
    deps.db,
    deps.skills.assigned,
    deps.mcp.agentServers,
  );
  return {
    store,
    byId: (id) => store.byId(id),
    usesProvider: (providerId) => store.usesProvider(providerId),
    routes: [
      ...routes({ ...deps, store }),
      ...startingRoutes({ store, users: deps.users }),
      ...directoryRoutes({ ...deps, store }),
    ],
  };
}
