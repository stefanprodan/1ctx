// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Projects: the container everything lives in. Only the personal
// project exists so far, made with the user.

import type { Db } from "../db/index.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type AccessPort, routes, type UsersPort } from "./routes.ts";
import { type ProjectRow, ProjectStore } from "./store.ts";

export { type AccessPort, type RoutesDeps, routes } from "./routes.ts";
export { type ProjectRow, ProjectStore, summary } from "./store.ts";
export { visible } from "./visible.ts";

export type ProjectsDeps = {
  db: Db;
  access: AccessPort;
  users: UsersPort;
};

export type Projects = {
  store: ProjectStore;
  byId(id: string): ProjectRow | null;
  isMember(projectId: string, userId: string): boolean;
  memberProjectIds(userId: string): string[];
  teamProjectIds(): string[];
  createPersonal(fields: { userId: string; name: string; now: number }): void;
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
    createPersonal: (fields) => {
      store.createPersonal(fields);
    },
    routes: routes({ store, access: deps.access, users: deps.users }),
  };
}
