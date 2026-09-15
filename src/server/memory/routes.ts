// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  MemoryResponse,
  SaveMemoryRequest,
  UndoMemoryRequest,
} from "../../shared/api/memory.ts";
import { jsonBody } from "../lib/body.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import { json } from "../lib/http.ts";
import type { ProjectRow } from "../projects/index.ts";
import { MAX_MEMORY_BODY, parseSaveMemory, parseUndoMemory } from "./parse.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type MemoryPort = {
  read(
    projectId: string,
    automationId: string | null,
  ): MemoryResponse["memory"];
  save(
    projectId: string,
    automationId: string | null,
    request: SaveMemoryRequest,
    userId: string,
  ): MemoryResponse["memory"];
  undo(
    projectId: string,
    automationId: string | null,
    request: UndoMemoryRequest,
    userId: string,
  ): MemoryResponse["memory"];
};

export type RoutesDeps = {
  access: AccessPort;
  memory: MemoryPort;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/projects/:id/memory",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: MemoryResponse = {
          memory: deps.memory.read(project.id, null),
        };
        return json(body);
      },
    },
    {
      method: "PUT",
      path: "/api/projects/:id/memory",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const request: SaveMemoryRequest = parseSaveMemory(
          await jsonBody(req, MAX_MEMORY_BODY),
        );
        const body: MemoryResponse = {
          memory: deps.memory.save(
            project.id,
            null,
            request,
            ctx.principal!.userId,
          ),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/memory/undo",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const request: UndoMemoryRequest = parseUndoMemory(
          await jsonBody(req, MAX_MEMORY_BODY),
        );
        const body: MemoryResponse = {
          memory: deps.memory.undo(
            project.id,
            null,
            request,
            ctx.principal!.userId,
          ),
        };
        return json(body);
      },
    },
  ];
}
