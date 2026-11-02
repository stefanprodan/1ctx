// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's MCP servers, as its Settings tab lists them, and an
// admin's add and remove of a team project on a server's list. A row
// carries no URL and no key file.

import type {
  AddProjectMcpRequest,
  ProjectMcpResponse,
} from "../../shared/api/mcp.ts";
import { inScope } from "../../shared/mcp.ts";
import { type Db, transact } from "../db/index.ts";
import { fields, jsonBody } from "../lib/body.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { McpServerRow, McpServerStore } from "./store.ts";

export type ProjectRoutesDeps = {
  db: Db;
  store: McpServerStore;
  access: {
    project(principal: Principal, id: string): { id: string; kind: string };
  };
  teamName(id: string): string | null;
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

export function projectRoutes(deps: ProjectRoutesDeps): RouteDescriptor[] {
  const list = (
    project: { id: string; kind: string },
    admin: boolean,
  ): ProjectMcpResponse => {
    const rows = deps.store.list();
    const shown = rows.filter((row) => inScope(row, project.id));
    const counts = deps.toolCounts(shown);
    return {
      servers: shown.map((row) => ({
        id: row.id,
        name: row.name,
        tools: counts.get(row.id) ?? 0,
        scope: row.scope,
      })),
      addable:
        admin && project.kind === "team"
          ? rows
              .filter(
                (row) => row.scope === "projects" && !inScope(row, project.id),
              )
              .map((row) => ({ id: row.id, name: row.name }))
          : [],
    };
  };
  const team = (id: string) => {
    if (deps.teamName(id) === null) throw new NotFound("no such project");
    return { id, kind: "team" };
  };
  // a server whose scope is a list; an all server is changed on its page
  const listed = (id: string) => {
    const row = deps.store.byId(id);
    if (row === null) throw new NotFound("no such MCP server");
    if (row.scope === "all") {
      throw new Conflict("the MCP server is offered in every project");
    }
    return row;
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
        return new Response(null, { status: 204 });
      },
    },
  ];
}
