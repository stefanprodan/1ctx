// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Agents: a name, an avatar, a provider and a model, and the system
// prompt. The rest of what an agent carries comes later.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import {
  directoryRoutes,
  type SkillsListPort,
  type ToolsPort,
} from "./directory.ts";
import {
  type AccessPort,
  type AutomationsPort,
  type ProvidersPort,
  routes,
  type SessionsPort,
  type SkillsPort,
} from "./routes.ts";
import { type AgentRow, AgentStore } from "./store.ts";

export {
  type DirectoryDeps,
  directoryRoutes,
  type SkillsListPort,
  type ToolsPort,
} from "./directory.ts";
export {
  type AccessPort,
  type AutomationsPort,
  type ProvidersPort,
  type RoutesDeps,
  routes,
  type SessionsPort,
  type SkillsPort,
} from "./routes.ts";
export { type AgentRow, AgentStore, summary } from "./store.ts";

export type AgentsDeps = {
  db: Db;
  clock: Clock;
  providers: ProvidersPort;
  skills: SkillsPort & SkillsListPort & { assigned(agentId: string): string[] };
  tools: ToolsPort;
  access: AccessPort;
  sessions: SessionsPort;
  automations: AutomationsPort;
};

export type Agents = {
  store: AgentStore;
  byId(id: string): AgentRow | null;
  usesProvider(providerId: string): boolean;
  routes: RouteDescriptor[];
};

export function agentsArea(deps: AgentsDeps): Agents {
  const store = new AgentStore(deps.db, deps.skills.assigned);
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
        access: deps.access,
        sessions: deps.sessions,
        automations: deps.automations,
        clock: deps.clock,
      }),
      ...directoryRoutes({
        store,
        providers: deps.providers,
        skills: deps.skills,
        tools: deps.tools,
        clock: deps.clock,
      }),
    ],
  };
}
