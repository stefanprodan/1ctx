// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Agents: a name, an avatar, a provider and a model, and the system
// prompt. The rest of what an agent carries comes later.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import {
  type AccessPort,
  type AutomationsPort,
  type ProvidersPort,
  routes,
  type SessionsPort,
} from "./routes.ts";
import { type AgentRow, AgentStore } from "./store.ts";

export {
  type AccessPort,
  type AutomationsPort,
  type ProvidersPort,
  type RoutesDeps,
  routes,
  type SessionsPort,
} from "./routes.ts";
export { type AgentRow, AgentStore, summary } from "./store.ts";

export type AgentsDeps = {
  db: Db;
  clock: Clock;
  providers: ProvidersPort;
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
  const store = new AgentStore(deps.db);
  return {
    store,
    byId: (id) => store.byId(id),
    usesProvider: (providerId) => store.usesProvider(providerId),
    routes: routes({
      store,
      providers: deps.providers,
      access: deps.access,
      sessions: deps.sessions,
      automations: deps.automations,
      clock: deps.clock,
    }),
  };
}
