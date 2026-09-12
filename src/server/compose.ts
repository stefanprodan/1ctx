// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composition root: the areas in layer order with the ports they
// declared, the complete route list, the router. main.ts calls it with
// the flags; the test helper calls it with a memory db and a fake clock,
// so a test exercises the wiring the binary runs.

import {
  access,
  routes as accessRoutes,
  LoginStore,
  profileRoutes,
} from "./access/index.ts";
import { AgentStore, routes as agentRoutes } from "./agents/index.ts";
import type { Db } from "./db/index.ts";
import type { Clock } from "./lib/clock.ts";
import type { RouteDescriptor } from "./lib/http.ts";
import type { Log } from "./lib/log.ts";
import { ProjectStore, routes as projectRoutes } from "./projects/index.ts";
import {
  Catalogs,
  type Fetcher,
  ProviderStore,
  routes as providerRoutes,
} from "./providers/index.ts";
import {
  bootstrap,
  createUser,
  type UserDeps,
  UserStore,
  summary as userSummary,
} from "./users/index.ts";
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
  logins: LoginStore;
  providers: ProviderStore;
  agents: AgentStore;
  catalogs: Catalogs;
  // the one way a user is made: with its personal project
  createUser: (
    fields: Parameters<typeof createUser>[1],
  ) => ReturnType<typeof createUser>;
  routes: RouteDescriptor[];
  handle: Router;
  // drop expired logins; called at start and every hour
  sweep(): number;
};

export async function compose(options: ComposeOptions): Promise<App> {
  const { db, clock } = options;
  const users = new UserStore(db);
  const projects = new ProjectStore(db);
  const userDeps: UserDeps = {
    db,
    store: users,
    onCreated: (user) =>
      projects.createPersonal({
        userId: user.id,
        name: user.username,
        now: user.createdAt,
      }),
  };
  await bootstrap({
    ...userDeps,
    secret: options.secret,
    clock,
    log: options.log("users"),
  });
  const logins = new LoginStore(db);
  const providers = new ProviderStore(db);
  const agents = new AgentStore(db);
  const catalogs = new Catalogs({
    fetcher: options.fetcher ?? fetch,
    clock,
    secret: options.secret,
  });
  const auth = access({
    logins,
    user: (id) => users.byId(id),
    project: (id) => projects.byId(id),
    member: (projectId, userId) => projects.isMember(projectId, userId),
    clock,
    secureCookie: options.secureCookie,
  });
  const routes: RouteDescriptor[] = [
    ...accessRoutes({
      db,
      access: auth,
      userByUsername: (username) => users.byUsername(username),
      clock,
      log: options.log("access"),
    }),
    ...profileRoutes({
      db,
      logins,
      userById: (id) => users.byId(id),
      setDetails: (id, fields) => users.setDetails(id, fields),
      setPasswordHash: (id, hash) => users.setPasswordHash(id, hash),
      clock,
      log: options.log("access"),
    }),
    ...projectRoutes({
      store: projects,
      access: auth,
      userSummary: (id) => {
        const user = users.byId(id);
        return user ? userSummary(user) : null;
      },
    }),
    ...providerRoutes({
      store: providers,
      catalogs,
      hasSecret: (name) => options.secret(name) !== null,
      inUse: (providerId) => agents.usesProvider(providerId),
      clock,
    }),
    ...agentRoutes({ store: agents, providers, catalogs, clock }),
    healthRoute(options.version),
  ];
  const handle = router({
    routes,
    resolve: (req) => auth.resolve(req),
    trustProxy: options.trustProxy,
  });
  return {
    users,
    projects,
    logins,
    providers,
    agents,
    catalogs,
    createUser: (fields) => createUser(userDeps, fields),
    routes,
    handle,
    sweep: () => auth.sweep(),
  };
}
