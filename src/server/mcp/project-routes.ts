// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's MCP servers, as its Settings tab lists them: an admin's
// add and remove of a team project on a server's list, and the
// project's choice of each server, an admin's on a team project and
// the owner's on a personal one. A row carries no URL and no key file.

import type {
  AddProjectMcpRequest,
  ProjectMcpResponse,
  ProjectMcpSideRequest,
} from "../../shared/api/mcp.ts";
import { ceilingOf, offeredSide, SIDE_RANK } from "../../shared/mcp.ts";
import type { ProjectKind } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { fields, jsonBody } from "../lib/body.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { parseSide } from "./parse.ts";
import type { McpServerRow, McpServerStore } from "./store.ts";

type Project = { id: string; kind: ProjectKind };

export type ProjectRoutesDeps = {
  db: Db;
  store: McpServerStore;
  access: {
    project(principal: Principal, id: string): Project;
  };
  teamName(id: string): string | null;
  // the user's personal project
  personal(userId: string): { id: string } | null;
  // each server's own tool count, by id
  toolCounts(rows: McpServerRow[]): Map<string, number>;
};

function parseAdd(body: unknown): AddProjectMcpRequest {
  const b = fields(body, ["serverId"]);
  if (typeof b.serverId !== "string" || b.serverId === "") {
    throw new BadRequest("serverId must be an id");
  }
  return { serverId: b.serverId };
}

function parseSideBody(body: unknown): ProjectMcpSideRequest {
  const b = fields(body, ["side"]);
  return { side: parseSide(b.side, "side") };
}

export function projectRoutes(deps: ProjectRoutesDeps): RouteDescriptor[] {
  const list = (project: Project, admin: boolean): ProjectMcpResponse => {
    const rows = deps.store.list();
    const chosen = deps.store.choices(project.id)?.sides ?? new Map();
    const shown = rows.filter((row) => ceilingOf(row, project) !== "off");
    const counts = deps.toolCounts(shown);
    return {
      servers: shown.map((row) => ({
        id: row.id,
        name: row.name,
        tools: counts.get(row.id) ?? 0,
        scope: row.scope,
        choice: chosen.get(row.id) ?? "read",
        ceiling: ceilingOf(row, project),
        side: offeredSide(row, project, chosen.get(row.id)),
        read: row.read,
        ...(admin && project.kind === "team" && row.scope === "projects"
          ? { projects: row.projectIds.length }
          : {}),
      })),
      addable:
        admin && project.kind === "team"
          ? rows
              .filter(
                (row) =>
                  row.scope === "projects" &&
                  !row.projectIds.includes(project.id),
              )
              .map((row) => ({ id: row.id, name: row.name }))
          : [],
    };
  };
  const team = (id: string): Project => {
    if (deps.teamName(id) === null) throw new NotFound("no such project");
    return { id, kind: "team" };
  };
  const personal = (principal: Principal): Project => {
    const project = deps.personal(principal.userId);
    if (project === null) throw new NotFound("no such project");
    return { id: project.id, kind: "personal" };
  };
  // a server whose scope is a list; an all server is changed on its page
  const listed = (id: string) => {
    const row = deps.store.byId(id);
    if (row === null) throw new NotFound("no such MCP server");
    if (row.scope === "all") {
      throw new Conflict("the MCP server is offered in every team project");
    }
    return row;
  };
  // in one transaction, so a grant lowered meanwhile is read
  const choose = (project: () => Project, serverId: string, body: unknown) => {
    const { side } = parseSideBody(body);
    transact(deps.db, () => {
      const held = project();
      const row = deps.store.byId(serverId);
      const ceiling = row === null ? "off" : ceilingOf(row, held);
      if (row === null || ceiling === "off") {
        throw new NotFound("the MCP server is not granted to the project");
      }
      if (SIDE_RANK[side] > SIDE_RANK[ceiling]) {
        throw new BadRequest(`side may be at most ${ceiling}`);
      }
      deps.store.setChoice(held.id, row.id, side);
      return { result: undefined };
    });
  };
  return [
    {
      method: "GET",
      path: "/api/projects/:id/mcp",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        return json(list(project, ctx.principal!.role === "admin"));
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/mcp",
      policy: "admin",
      async handle(req, ctx) {
        const { serverId } = parseAdd(await jsonBody(req));
        transact(deps.db, () => {
          const project = team(ctx.params.id);
          if (!deps.store.addProject(listed(serverId).id, project.id)) {
            throw new Conflict("the MCP server already lists the project");
          }
          return { result: undefined };
        });
        return json(list(team(ctx.params.id), true), 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id/mcp/:serverId",
      policy: "admin",
      handle(_req, ctx) {
        transact(deps.db, () => {
          const project = team(ctx.params.id);
          const row = listed(ctx.params.serverId);
          if (!deps.store.removeProject(row.id, project.id)) {
            throw new NotFound("the MCP server does not list the project");
          }
          return { result: undefined };
        });
        return json(list(team(ctx.params.id), true));
      },
    },
    {
      method: "PUT",
      path: "/api/projects/:id/mcp/:serverId/side",
      policy: "admin",
      async handle(req, ctx) {
        const body = await jsonBody(req);
        choose(() => team(ctx.params.id), ctx.params.serverId, body);
        return json(list(team(ctx.params.id), true));
      },
    },
    {
      method: "PUT",
      path: "/api/profile/project/mcp/:serverId/side",
      policy: "authenticated",
      async handle(req, ctx) {
        const body = await jsonBody(req);
        const principal = ctx.principal!;
        choose(() => personal(principal), ctx.params.serverId, body);
        return json(list(personal(principal), principal.role === "admin"));
      },
    },
  ];
}
