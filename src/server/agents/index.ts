// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Agents: a name, an avatar, a provider and a model, and the system
// prompt. The MCP capability owns the agent-to-server rows.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Mcp } from "../mcp/index.ts";
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
  type ProvidersPort,
  type RunnerPort,
  routes,
  type SessionsPort,
  type SkillsPort,
} from "./routes.ts";
import { type PicksPort, startingRoutes } from "./starting.ts";
import { type AgentRow, AgentStore } from "./store.ts";

export {
  type DirectoryDeps,
  directoryRoutes,
  type SkillsListPort,
  type ToolsPort,
  type UsagePort,
} from "./directory.ts";
export {
  MAX_MODEL,
  MAX_PROMPT,
  MAX_SERVERS_PER_AGENT,
} from "./parse.ts";
export {
  type AccessPort,
  type AutomationsPort,
  type CredentialsPort,
  type McpPort,
  type ProvidersPort,
  type RoutesDeps,
  type RunnerPort,
  routes,
  type SessionsPort,
  type SkillsPort,
} from "./routes.ts";
export type { PicksPort } from "./starting.ts";
export { type AgentRow, AgentStore, summary } from "./store.ts";

export type AgentsDeps = {
  db: Db;
  clock: Clock;
  providers: ProvidersPort;
  skills: SkillsPort & SkillsListPort & { assigned(agentId: string): string[] };
  mcp: Pick<Mcp, "agentServers" | "setAgentServers" | "switchableBy">;
  tools: ToolsPort & CapabilitiesPort;
  credentials: CredentialsPort;
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
      ...routes({
        db: deps.db,
        store,
        providers: deps.providers,
        skills: deps.skills,
        mcp: deps.mcp,
        tools: deps.tools,
        credentials: deps.credentials,
        access: deps.access,
        sessions: deps.sessions,
        automations: deps.automations,
        runner: deps.runner,
        users: deps.users,
        clock: deps.clock,
      }),
      ...startingRoutes({ store, users: deps.users }),
      ...directoryRoutes({
        store,
        usage: deps.usage,
        providers: deps.providers,
        skills: deps.skills,
        tools: deps.tools,
        clock: deps.clock,
      }),
    ],
  };
}
