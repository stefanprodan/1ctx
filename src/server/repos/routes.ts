// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The repository routes. Anyone who sees a project lists its
// repositories; admins write a team project's, and an owner their
// personal project's under /api/profile/project/repos, so no route lets
// a member write a team project's.

import type {
  CreateRepoRequest,
  PatchRepoRequest,
  RepoResponse,
  ReposResponse,
} from "../../shared/api/repos.ts";
import { repoKey } from "../../shared/capabilities.ts";
import { MAX_REPOS_PER_PROJECT } from "../../shared/contracts/repo.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import {
  type CredentialsPort,
  checkRepo,
  desired,
  type RepoProject,
  refetches,
} from "./check.ts";
import { parseCreateRepo, parsePatchRepo } from "./parse.ts";
import { type ReposStore, view } from "./store.ts";

export type AccessPort = {
  // the project the principal may see, else a 404
  project(principal: Principal, id: string): RepoProject;
};

export type ProjectsPort = {
  byId(id: string): RepoProject | null;
  personal(userId: string): RepoProject | null;
};

// in the caller's transaction: a deleted repository's key leaves every
// disabled set of its project's chats and tasks
export type CapabilitiesPort = {
  forget(key: string, projectId: string): void;
};

export type RoutesDeps = {
  db: Db;
  store: ReposStore;
  clock: Clock;
  access: AccessPort;
  projects: ProjectsPort;
  credentials: Pick<CredentialsPort, "byId">;
  capabilities: CapabilitiesPort;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const answer = (row: Parameters<typeof view>[0]): RepoResponse => ({
    repo: view(row),
  });
  const team = (id: string): RepoProject => {
    const project = deps.projects.byId(id);
    if (project === null || project.kind !== "team") {
      throw new NotFound("no such project");
    }
    return project;
  };
  const personal = (principal: Principal): RepoProject => {
    const project = deps.projects.personal(principal.userId);
    if (project === null) throw new NotFound("no such project");
    return project;
  };
  const find = (project: RepoProject, id: string) => {
    const row = deps.store.inProject(project.id, id);
    if (row === null) throw new NotFound("no such repository");
    return row;
  };
  const nameFree = (project: RepoProject, name: string, exceptId?: string) => {
    if (deps.store.nameTaken(project.id, name, exceptId)) {
      throw new Conflict(`a repository named ${name} exists`);
    }
  };

  const create = (project: RepoProject, change: CreateRepoRequest) =>
    transact(deps.db, () => {
      const fields = desired(null, change);
      checkRepo(project, fields, deps.credentials);
      if (deps.store.count(project.id) >= MAX_REPOS_PER_PROJECT) {
        throw new Conflict(
          `a project holds at most ${MAX_REPOS_PER_PROJECT} repositories`,
        );
      }
      nameFree(project, fields.name);
      return {
        result: answer(deps.store.create(project.id, fields, deps.clock())),
      };
    });
  const patch = (project: RepoProject, id: string, change: PatchRepoRequest) =>
    transact(deps.db, () => {
      const before = find(project, id);
      const fields = desired(before, change);
      checkRepo(project, fields, deps.credentials);
      nameFree(project, fields.name, before.id);
      const after = deps.store.update(
        before.id,
        fields,
        refetches(before, fields),
        deps.clock(),
      );
      return { result: answer(after!) };
    });
  const remove = (project: RepoProject, id: string) => {
    transact(deps.db, () => {
      const row = find(project, id);
      deps.store.delete(row.id);
      deps.capabilities.forget(repoKey(row.id), project.id);
      return { result: undefined };
    });
    return new Response(null, { status: 204 });
  };
  const refresh = (project: RepoProject, id: string) =>
    transact(deps.db, () => {
      const row = find(project, id);
      return { result: answer(deps.store.markPending(row.id, deps.clock())!) };
    });

  return [
    {
      method: "GET",
      path: "/api/projects/:id/repos",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: ReposResponse = {
          repos: deps.store.forProject(project.id).map(view),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/repos",
      policy: "admin",
      async handle(req, ctx) {
        const project = team(ctx.params.id);
        const change = parseCreateRepo(await jsonBody(req));
        return json(create(project, change), 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/projects/:id/repos/:repoId",
      policy: "admin",
      async handle(req, ctx) {
        const project = team(ctx.params.id);
        const change = parsePatchRepo(await jsonBody(req));
        return json(patch(project, ctx.params.repoId, change));
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id/repos/:repoId",
      policy: "admin",
      handle(_req, ctx) {
        return remove(team(ctx.params.id), ctx.params.repoId);
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/repos/:repoId/refresh",
      policy: "admin",
      handle(_req, ctx) {
        return json(refresh(team(ctx.params.id), ctx.params.repoId));
      },
    },
    {
      method: "POST",
      path: "/api/profile/project/repos",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = personal(ctx.principal!);
        const change = parseCreateRepo(await jsonBody(req));
        return json(create(project, change), 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/profile/project/repos/:repoId",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = personal(ctx.principal!);
        const change = parsePatchRepo(await jsonBody(req));
        return json(patch(project, ctx.params.repoId, change));
      },
    },
    {
      method: "DELETE",
      path: "/api/profile/project/repos/:repoId",
      policy: "authenticated",
      handle(_req, ctx) {
        return remove(personal(ctx.principal!), ctx.params.repoId);
      },
    },
    {
      method: "POST",
      path: "/api/profile/project/repos/:repoId/refresh",
      policy: "authenticated",
      handle(_req, ctx) {
        return json(refresh(personal(ctx.principal!), ctx.params.repoId));
      },
    },
  ];
}
