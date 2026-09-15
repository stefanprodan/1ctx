// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Projects: the personal and team containers everything lives in.

import type { ProjectSummary } from "../../shared/contracts/project.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import {
  type AccessPort,
  routes,
  type SessionsPort,
  type UsagePort,
  type UsersPort,
} from "./routes.ts";
import { type ProjectRow, ProjectStore } from "./store.ts";

export {
  type AccessPort,
  type RoutesDeps,
  routes,
  type SessionsPort,
  type UsagePort,
} from "./routes.ts";
export { type ProjectRow, ProjectStore, summary } from "./store.ts";
export { visible } from "./visible.ts";

export type ProjectsDeps = {
  db: Db;
  clock: Clock;
  access: AccessPort;
  users: UsersPort;
  sessions: SessionsPort;
  usage: UsagePort;
};

export type Projects = {
  store: ProjectStore;
  byId(id: string): ProjectRow | null;
  isMember(projectId: string, userId: string): boolean;
  memberProjectIds(userId: string): string[];
  teamProjectIds(): string[];
  visibleFor(userId: string, admin: boolean): ProjectSummary[];
  personal(userId: string): ProjectRow | null;
  createPersonal(fields: { userId: string; now: number }): void;
  routes: RouteDescriptor[];
};

export function projectsArea(deps: ProjectsDeps): Projects {
  const store = new ProjectStore(deps.db);
  return {
    store,
    byId: (id) => store.byId(id),
    isMember: (projectId, userId) => store.isMember(projectId, userId),
    memberProjectIds: (userId) => store.memberProjectIds(userId),
    teamProjectIds: () => store.teamProjectIds(),
    visibleFor: (userId, admin) => store.visibleFor(userId, admin),
    personal: (userId) => store.personal(userId),
    createPersonal: (fields) => {
      store.createPersonal(fields);
    },
    routes: routes({
      db: deps.db,
      store,
      access: deps.access,
      users: deps.users,
      sessions: deps.sessions,
      usage: deps.usage,
      clock: deps.clock,
    }),
  };
}
