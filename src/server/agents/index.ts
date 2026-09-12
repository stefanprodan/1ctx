// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Agents: a name, an avatar, a provider and a model, and the system
// prompt. The rest of what an agent carries comes later.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type ProvidersPort, routes } from "./routes.ts";
import { AgentStore } from "./store.ts";

export { type ProvidersPort, type RoutesDeps, routes } from "./routes.ts";
export { type AgentRow, AgentStore, summary } from "./store.ts";

export type AgentsDeps = {
  db: Db;
  clock: Clock;
  providers: ProvidersPort;
};

export type Agents = {
  store: AgentStore;
  usesProvider(providerId: string): boolean;
  routes: RouteDescriptor[];
};

export function agentsArea(deps: AgentsDeps): Agents {
  const store = new AgentStore(deps.db);
  return {
    store,
    usesProvider: (providerId) => store.usesProvider(providerId),
    routes: routes({ store, providers: deps.providers, clock: deps.clock }),
  };
}
