// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composition root: the areas in layer order with the ports they
// declared, the complete route list, the router. main.ts calls it with
// the flags; the test helper calls it with a memory db and a fake clock,
// so a test exercises the wiring the binary runs.

import { access, routes as accessRoutes, LoginStore } from "./access/index.ts";
import type { Db } from "./db/index.ts";
import type { Clock } from "./lib/clock.ts";
import type { RouteDescriptor } from "./lib/http.ts";
import type { Log } from "./lib/log.ts";
import { bootstrap, UserStore } from "./users/index.ts";
import { healthRoute } from "./web/health.ts";
import { type Router, router } from "./web/router.ts";

export type ComposeOptions = {
  db: Db;
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
  clock: Clock;
  log: (area: string) => Log;
  version: string;
  secureCookie: boolean;
  trustProxy: boolean;
};

export type App = {
  users: UserStore;
  logins: LoginStore;
  routes: RouteDescriptor[];
  handle: Router;
  // drop expired logins; called at start and every hour
  sweep(): number;
};

export async function compose(options: ComposeOptions): Promise<App> {
  const { db, clock } = options;
  const users = new UserStore(db);
  await bootstrap({
    store: users,
    secret: options.secret,
    clock,
    log: options.log("users"),
  });
  const logins = new LoginStore(db);
  const auth = access({
    logins,
    user: (id) => users.byId(id),
    clock,
    secureCookie: options.secureCookie,
  });
  const routes: RouteDescriptor[] = [
    ...accessRoutes({
      db,
      access: auth,
      userByName: (name) => users.byName(name),
      clock,
      log: options.log("access"),
    }),
    healthRoute(options.version),
  ];
  const handle = router({
    routes,
    resolve: (req) => auth.resolve(req),
    trustProxy: options.trustProxy,
  });
  return { users, logins, routes, handle, sweep: () => auth.sweep() };
}
