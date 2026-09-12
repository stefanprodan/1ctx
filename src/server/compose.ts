// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composition root: the areas in layer order, each built by its
// own factory with the capabilities of the areas it declared ports to,
// the complete route list, the router. main.ts calls it with the
// flags; the test helper calls it with a memory db and a fake clock,
// so a test exercises the wiring the binary runs.

import { type Access, accessArea } from "./access/index.ts";
import { type AgentStore, agentsArea } from "./agents/index.ts";
import type { Db } from "./db/index.ts";
import type { Clock } from "./lib/clock.ts";
import type { RouteDescriptor } from "./lib/http.ts";
import type { Log } from "./lib/log.ts";
import { type ProjectStore, projectsArea } from "./projects/index.ts";
import {
  type Catalogs,
  type Fetcher,
  type ProviderStore,
  providersArea,
} from "./providers/index.ts";
import { type UserStore, type Users, usersArea } from "./users/index.ts";
import { healthRoute } from "./web/health.ts";
import { type Router, router } from "./web/router.ts";

export type ComposeOptions = {
  db: Db;
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
  clock: Clock;
  // what reaches a provider; a test passes a fake
  fetcher?: Fetcher;
  log: (area: string) => Log;
  version: string;
  secureCookie: boolean;
  trustProxy: boolean;
};

export type App = {
  users: UserStore;
  projects: ProjectStore;
  providers: ProviderStore;
  agents: AgentStore;
  catalogs: Catalogs;
  // the one way a user is made: with its personal project
  createUser: Users["createUser"];
  routes: RouteDescriptor[];
  handle: Router;
  // drop expired logins; called at start and every hour
  sweep(): number;
};

export async function compose(options: ComposeOptions): Promise<App> {
  const { db, clock, secret } = options;
  // Three ports point down the list, at an area built after the one
  // that holds them: a user is made with its personal project, a
  // provider an agent runs on cannot go, and a project route asks
  // access what the principal may see. Each runs once the list is
  // complete, never while it is built; a closure is the whole cost.
  const users = usersArea({
    db,
    secret,
    clock,
    log: options.log("users"),
    projects: { createPersonal: (fields) => projects.createPersonal(fields) },
  });
  const providers = providersArea({
    db,
    clock,
    secret,
    fetcher: options.fetcher ?? fetch,
    agents: { usesProvider: (providerId) => agents.usesProvider(providerId) },
  });
  const projects = projectsArea({
    db,
    access: { project: (principal, id) => access.project(principal, id) },
    users,
  });
  const access: Access = accessArea({
    db,
    clock,
    log: options.log("access"),
    secureCookie: options.secureCookie,
    users,
    projects,
  });
  const agents = agentsArea({ db, clock, providers });
  await users.bootstrap();
  const routes: RouteDescriptor[] = [
    ...users.routes,
    ...providers.routes,
    ...projects.routes,
    ...access.routes,
    ...agents.routes,
    healthRoute(options.version),
  ];
  const handle = router({
    routes,
    resolve: (req) => access.resolve(req),
    trustProxy: options.trustProxy,
  });
  return {
    users: users.store,
    projects: projects.store,
    providers: providers.store,
    agents: agents.store,
    catalogs: providers.catalogs,
    createUser: users.createUser,
    routes,
    handle,
    sweep: () => access.sweep(),
  };
}
