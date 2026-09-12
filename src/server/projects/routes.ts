// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The caller's projects, and one project with its members. Whether the
// caller may see a project is access's call, through the port; a
// project they may not see is a 404, the same as one that is not there.

import type {
  ProjectResponse,
  ProjectsResponse,
} from "../../shared/api/projects.ts";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { type UserRow, summary as userSummary } from "../users/index.ts";
import { type ProjectRow, type ProjectStore, summary } from "./store.ts";

// what may be seen is decided in one place for every area that serves
// a project resource: the project, or the one 404 thrown
export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type UsersPort = {
  byId(id: string): UserRow | null;
};

export type RoutesDeps = {
  store: ProjectStore;
  access: AccessPort;
  users: UsersPort;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/projects",
      policy: "authenticated",
      handle(_req, ctx) {
        const body: ProjectsResponse = {
          projects: deps.store.forUser(ctx.principal!.userId).map(summary),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const members: UserSummary[] = [];
        for (const id of deps.store.memberIds(project.id)) {
          const user = deps.users.byId(id);
          if (user !== null) members.push(userSummary(user));
        }
        const body: ProjectResponse = {
          project: {
            ...summary(project),
            createdAt: project.createdAt,
            members,
          },
        };
        return json(body);
      },
    },
  ];
}
