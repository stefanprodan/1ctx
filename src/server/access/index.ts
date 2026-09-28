// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access: logins, the principal, the login, logout and me routes, the
// signed-in profile routes, and admin user management.
// What other areas and compose.ts may import.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import {
  type Auth,
  type ProjectsPort as AuthProjectsPort,
  type UsersPort as AuthUsersPort,
  auth,
} from "./auth.ts";
import {
  type BoardUsagePort,
  boardRoutes,
  type PresencePort,
} from "./board.ts";
import {
  type ActivityPort,
  type ProjectsPort as DirectoryProjectsPort,
  type UsersPort as DirectoryUsersPort,
  directoryRoutes,
} from "./directory.ts";
import {
  type UsersPort as ProfileUsersPort,
  profileRoutes,
} from "./profile.ts";
import { type UsersPort as LoginUsersPort, routes } from "./routes.ts";
import { LoginStore } from "./store.ts";
import {
  type UsersPort as AdminUsersPort,
  type UsersProjectsPort,
  type UsersUsagePort,
  usersRoutes,
} from "./users.ts";
import { VISIT_RETENTION_MS, VisitStore } from "./visits.ts";

export {
  type Auth,
  auth,
  COOKIE,
  cookieValue,
  LOGIN_TTL_MS,
  TOUCH_AFTER_MS,
} from "./auth.ts";
export {
  type ActivityPort,
  directoryRoutes,
} from "./directory.ts";
export {
  parseAbout,
  parseEmail,
  parseFullName,
  parseNoQuery,
  parseTz,
  parseUsername,
  parseUserPassword,
} from "./parse.ts";
export { profileRoutes } from "./profile.ts";
export { routes } from "./routes.ts";
export { LoginStore } from "./store.ts";
export {
  type UsersPort as AdminUsersPort,
  usersRoutes,
} from "./users.ts";
export { VISIT_RETENTION_MS, VisitStore } from "./visits.ts";

export type AccessDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  // the Secure attribute: on when the app is served over TLS
  secureCookie: boolean;
  users: AuthUsersPort &
    LoginUsersPort &
    ProfileUsersPort &
    AdminUsersPort &
    DirectoryUsersPort;
  projects: AuthProjectsPort & DirectoryProjectsPort & UsersProjectsPort;
  usage: UsersUsagePort & BoardUsagePort;
  // a person's posts, chats and manual runs: a closure, since sessions
  // is built after access
  activity: ActivityPort;
  // a closure, the socket is built after access
  presence: PresencePort;
};

export type Access = Auth & {
  store: LoginStore;
  // drop the visits past every window; how many went
  sweepVisits(): number;
  routes: RouteDescriptor[];
};

export function accessArea(deps: AccessDeps): Access {
  const logins = new LoginStore(deps.db);
  const visits = new VisitStore(deps.db);
  const built = auth({
    db: deps.db,
    logins,
    visits,
    users: deps.users,
    projects: deps.projects,
    clock: deps.clock,
    secureCookie: deps.secureCookie,
  });
  return {
    store: logins,
    ...built,
    sweepVisits: () => visits.deleteBefore(deps.clock() - VISIT_RETENTION_MS),
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
      ...usersRoutes({
        db: deps.db,
        logins,
        visits,
        users: deps.users,
        projects: deps.projects,
        usage: deps.usage,
        clock: deps.clock,
      }),
      ...boardRoutes({
        visits,
        logins,
        presence: deps.presence,
        users: deps.users,
        usage: deps.usage,
        projects: deps.projects,
        clock: deps.clock,
      }),
      ...directoryRoutes({
        users: deps.users,
        projects: deps.projects,
        activity: deps.activity,
        visits,
        clock: deps.clock,
      }),
    ],
  };
}
