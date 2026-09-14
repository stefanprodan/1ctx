// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  DeleteProjectResponse,
  ProjectResponse,
  ProjectsResponse,
} from "../../shared/api/projects.ts";
import type { ProjectDetail } from "../../shared/contracts/project.ts";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { type UserRow, summary as userSummary } from "../users/index.ts";
import {
  parseAddMember,
  parseCreateProject,
  parseUpdateProject,
} from "./parse.ts";
import { type ProjectRow, type ProjectStore, summary } from "./store.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type UsersPort = {
  byId(id: string): UserRow | null;
};

export type SessionsPort = {
  count(projectId: string): number;
  running(projectId: string): boolean;
};

export type UsagePort = {
  deleteProject(projectId: string): number;
};

export type RoutesDeps = {
  db: Db;
  store: ProjectStore;
  access: AccessPort;
  users: UsersPort;
  sessions: SessionsPort;
  usage: UsagePort;
  clock: Clock;
};

const uniqueName = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "SQLITE_CONSTRAINT_UNIQUE";

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const findTeam = (id: string): ProjectRow => {
    const project = deps.store.byId(id);
    if (project === null || project.kind !== "team") {
      throw new NotFound("no such project");
    }
    return project;
  };
  const detail = (project: ProjectRow): ProjectDetail => {
    const members: UserSummary[] = [];
    for (const id of deps.store.memberIds(project.id)) {
      const user = deps.users.byId(id);
      if (user !== null) members.push(userSummary(user));
    }
    return {
      ...summary(project, members.length),
      description: project.description,
      members,
      chats: deps.sessions.count(project.id),
    };
  };
  function writeName<T>(write: () => T): T {
    try {
      return write();
    } catch (error) {
      if (uniqueName(error)) throw new Conflict("name is taken");
      throw error;
    }
  }
  return [
    {
      method: "GET",
      path: "/api/projects",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const body: ProjectsResponse = {
          projects: deps.store.visibleFor(
            principal.userId,
            principal.role === "admin",
          ),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/projects",
      policy: "admin",
      async handle(req, ctx) {
        const { name, description } = parseCreateProject(await jsonBody(req));
        const project = transact(deps.db, () => {
          if (deps.store.nameTaken(name)) {
            throw new Conflict("name is taken");
          }
          const created = writeName(() =>
            deps.store.createTeam({
              ownerId: ctx.principal!.userId,
              name,
              description,
              now: deps.clock(),
            }),
          );
          return {
            result: detail(created),
            events: [
              {
                type: "access.changed" as const,
                data: { userIds: null },
              },
            ],
          };
        });
        const body: ProjectResponse = { project };
        return json(body, 201);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: ProjectResponse = { project: detail(project) };
        return json(body);
      },
    },
    {
      method: "PATCH",
      path: "/api/projects/:id",
      policy: "admin",
      async handle(req, ctx) {
        findTeam(ctx.params.id);
        const change = parseUpdateProject(await jsonBody(req));
        const project = transact(deps.db, () => {
          const current = findTeam(ctx.params.id);
          const name = change.name ?? current.name;
          if (deps.store.nameTaken(name, current.id)) {
            throw new Conflict("name is taken");
          }
          const updated = writeName(() =>
            deps.store.update(current.id, {
              name,
              description: change.description ?? current.description,
            }),
          );
          if (updated === null) throw new NotFound("no such project");
          return { result: detail(updated) };
        });
        const body: ProjectResponse = { project };
        return json(body);
      },
    },
    {
      // the caller's own personal project, the one project a member names
      // and describes
      method: "PATCH",
      path: "/api/profile/project",
      policy: "authenticated",
      async handle(req, ctx) {
        const change = parseUpdateProject(await jsonBody(req));
        const userId = ctx.principal!.userId;
        const project = transact(deps.db, () => {
          const current = deps.store.personal(userId);
          if (current === null) throw new NotFound("no such project");
          const name = change.name ?? current.name;
          if (deps.store.nameTaken(name, current.id)) {
            throw new Conflict("name is taken");
          }
          const updated = writeName(() =>
            deps.store.updatePersonal(userId, {
              name,
              description: change.description ?? current.description,
            }),
          );
          if (updated === null) throw new NotFound("no such project");
          return { result: detail(updated) };
        });
        const body: ProjectResponse = { project };
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id",
      policy: "admin",
      handle(_req, ctx) {
        const deleted = transact(deps.db, () => {
          const project = findTeam(ctx.params.id);
          if (deps.sessions.running(project.id)) {
            throw new Conflict("project has a running chat");
          }
          const chats = deps.sessions.count(project.id);
          deps.usage.deleteProject(project.id);
          if (!deps.store.remove(project.id)) {
            throw new NotFound("no such project");
          }
          return {
            result: chats,
            events: [
              {
                type: "access.changed" as const,
                data: { userIds: null },
              },
            ],
          };
        });
        const body: DeleteProjectResponse = { deleted };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/members",
      policy: "admin",
      async handle(req, ctx) {
        findTeam(ctx.params.id);
        const { userId } = parseAddMember(await jsonBody(req));
        const project = transact(deps.db, () => {
          const current = findTeam(ctx.params.id);
          if (deps.users.byId(userId) === null) {
            throw new NotFound("userId does not name a user");
          }
          if (deps.store.isMember(current.id, userId)) {
            throw new Conflict("userId is already a member");
          }
          try {
            deps.store.addMember(current.id, userId, deps.clock());
          } catch (error) {
            if (uniqueName(error)) {
              throw new Conflict("userId is already a member");
            }
            throw error;
          }
          return {
            result: detail(current),
            events: [
              {
                type: "access.changed" as const,
                data: { userIds: [userId] },
              },
            ],
          };
        });
        const body: ProjectResponse = { project };
        return json(body, 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id/members/:userId",
      policy: "admin",
      handle(_req, ctx) {
        const project = transact(deps.db, () => {
          const current = findTeam(ctx.params.id);
          if (deps.users.byId(ctx.params.userId) === null) {
            throw new NotFound("userId does not name a user");
          }
          if (!deps.store.removeMember(current.id, ctx.params.userId)) {
            throw new Conflict("userId is not a member");
          }
          return {
            result: detail(current),
            events: [
              {
                type: "access.changed" as const,
                data: { userIds: [ctx.params.userId] },
              },
            ],
          };
        });
        const body: ProjectResponse = { project };
        return json(body);
      },
    },
  ];
}
