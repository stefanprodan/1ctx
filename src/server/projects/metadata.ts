// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's metadata, its description and its labels, written by any
// user who sees the project: a team project's members and every admin,
// a personal project's owner alone. Agents never reach these routes.

import type { ProjectResponse } from "../../shared/api/projects.ts";
import { MAX_LABELS_PER_PROJECT } from "../../shared/contracts/label.ts";
import type { ProjectDetail } from "../../shared/contracts/project.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { parseAbout, parseCreateLabel, parseUpdateLabel } from "./parse.ts";
import {
  type ProjectRow,
  type ProjectStore,
  uniqueViolation,
} from "./store.ts";

export type AccessPort = {
  // the project the principal may see, else a 404
  project(principal: Principal, id: string): ProjectRow;
};

export type MetadataDeps = {
  db: Db;
  store: ProjectStore;
  access: AccessPort;
  clock: Clock;
  detail(project: ProjectRow): ProjectDetail;
};

export function metadataRoutes(deps: MetadataDeps): RouteDescriptor[] {
  // visibility is read again inside each write, so a member removed
  // meanwhile writes nothing
  const write = (
    principal: Principal,
    id: string,
    change: (project: ProjectRow) => ProjectRow,
    status = 200,
  ): Response => {
    const project = transact(deps.db, () => {
      const current = deps.access.project(principal, id);
      return { result: deps.detail(change(current)) };
    });
    const body: ProjectResponse = { project };
    return json(body, status);
  };
  const nameFree = (projectId: string, name: string, exceptId?: string) => {
    if (deps.store.labelTaken(projectId, name, exceptId)) {
      throw new Conflict("name is taken");
    }
  };
  function writeName<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (uniqueViolation(error)) throw new Conflict("name is taken");
      throw error;
    }
  }
  const findLabel = (projectId: string, id: string) => {
    const label = deps.store.label(projectId, id);
    if (label === null) throw new NotFound("no such label");
    return label;
  };
  return [
    {
      method: "PATCH",
      path: "/api/projects/:id/about",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const { kind } = deps.access.project(principal, ctx.params.id);
        const { description } = parseAbout(await jsonBody(req), kind);
        return write(principal, ctx.params.id, (project) => {
          const updated = deps.store.describe(project.id, description);
          if (updated === null) throw new NotFound("no such project");
          return updated;
        });
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/labels",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        deps.access.project(principal, ctx.params.id);
        const label = parseCreateLabel(await jsonBody(req));
        return write(
          principal,
          ctx.params.id,
          (project) => {
            if (deps.store.labelCount(project.id) >= MAX_LABELS_PER_PROJECT) {
              throw new Conflict(
                `a project holds at most ${MAX_LABELS_PER_PROJECT} labels`,
              );
            }
            nameFree(project.id, label.name);
            writeName(() =>
              deps.store.addLabel(project.id, label, deps.clock()),
            );
            return project;
          },
          201,
        );
      },
    },
    {
      method: "PATCH",
      path: "/api/projects/:id/labels/:labelId",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        deps.access.project(principal, ctx.params.id);
        const change = parseUpdateLabel(await jsonBody(req));
        return write(principal, ctx.params.id, (project) => {
          const before = findLabel(project.id, ctx.params.labelId);
          const name = change.name ?? before.name;
          nameFree(project.id, name, before.id);
          writeName(() =>
            deps.store.updateLabel(project.id, before.id, {
              name,
              description: change.description ?? before.description,
            }),
          );
          return project;
        });
      },
    },
    {
      // a project always offers one label to pick. Once items link
      // labels, their links go in this transaction too
      method: "DELETE",
      path: "/api/projects/:id/labels/:labelId",
      policy: "authenticated",
      handle(_req, ctx) {
        return write(ctx.principal!, ctx.params.id, (project) => {
          const label = findLabel(project.id, ctx.params.labelId);
          if (deps.store.labelCount(project.id) <= 1) {
            throw new Conflict("a project keeps at least one label");
          }
          deps.store.removeLabel(project.id, label.id);
          return project;
        });
      },
    },
  ];
}
