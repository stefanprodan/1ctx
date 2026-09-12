// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access: logins, the principal, the login, logout and me routes, and
// the profile routes of the signed-in user.
// What other areas and compose.ts may import.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import {
  type Auth,
  type UsersPort as AuthUsersPort,
  auth,
  type ProjectsPort,
} from "./auth.ts";
import {
  type UsersPort as ProfileUsersPort,
  profileRoutes,
} from "./profile.ts";
import { type UsersPort as LoginUsersPort, routes } from "./routes.ts";
import { LoginStore } from "./store.ts";

export {
  type Auth,
  type AuthDeps,
  auth,
  COOKIE,
  cookieValue,
  LOGIN_TTL_MS,
  type Resolution,
  TOUCH_AFTER_MS,
} from "./auth.ts";
export { type ProfileDeps, profileRoutes } from "./profile.ts";
export { type RoutesDeps, routes } from "./routes.ts";
export { type Login, LoginStore } from "./store.ts";

export type AccessDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  // the Secure attribute: on when the app is served over TLS
  secureCookie: boolean;
  users: AuthUsersPort & LoginUsersPort & ProfileUsersPort;
  projects: ProjectsPort;
};

export type Access = Auth & {
  store: LoginStore;
  routes: RouteDescriptor[];
};

export function accessArea(deps: AccessDeps): Access {
  const logins = new LoginStore(deps.db);
  const built = auth({
    db: deps.db,
    logins,
    users: deps.users,
    projects: deps.projects,
    clock: deps.clock,
    secureCookie: deps.secureCookie,
  });
  return {
    store: logins,
    ...built,
    routes: [
      ...routes({
        db: deps.db,
        auth: built,
        users: deps.users,
        clock: deps.clock,
        log: deps.log,
      }),
      ...profileRoutes({
        db: deps.db,
        logins,
        users: deps.users,
        clock: deps.clock,
        log: deps.log,
      }),
    ],
  };
}
