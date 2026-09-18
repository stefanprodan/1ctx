// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  KnowledgeFileDetailResponse,
  KnowledgeFileResponse,
  KnowledgeListResponse,
  KnowledgeVersionDetailResponse,
  KnowledgeVersionsResponse,
} from "../../shared/api/knowledge.ts";
import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import { jsonBody } from "../lib/body.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { ProjectRow } from "../projects/index.ts";
import { MAX_KNOWLEDGE_BODY } from "./limits.ts";
import { parseCreate, parseId, parseReplace } from "./parse.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type KnowledgePort = {
  list(projectId: string): KnowledgeListResponse;
  read(projectId: string, fileId: string): KnowledgeFileDetailResponse["file"];
  versions(
    projectId: string,
    fileId: string,
  ): KnowledgeVersionsResponse["versions"];
  version(
    projectId: string,
    versionId: string,
  ): KnowledgeVersionDetailResponse["version"];
  create(
    projectId: string,
    author: KnowledgeAuthor,
    name: string,
    text: string,
  ): KnowledgeFileResponse["file"];
  replace(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
    text: string,
    revision: number,
  ): KnowledgeFileResponse["file"];
  remove(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
  ): KnowledgeFileResponse["file"];
};

export type RoutesDeps = { access: AccessPort; knowledge: KnowledgePort };

function author(principal: Principal): KnowledgeAuthor {
  return {
    kind: "user",
    id: principal.userId,
    name: principal.username,
    sessionId: null,
    origin: null,
  };
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/projects/:id/knowledge",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: KnowledgeListResponse = deps.knowledge.list(project.id);
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/knowledge",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const request = parseCreate(await jsonBody(req, MAX_KNOWLEDGE_BODY));
        const body: KnowledgeFileResponse = {
          file: deps.knowledge.create(
            project.id,
            author(ctx.principal!),
            request.name,
            request.text,
          ),
        };
        return json(body, 201);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id/knowledge/files/:fileId",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: KnowledgeFileDetailResponse = {
          file: deps.knowledge.read(
            project.id,
            parseId(ctx.params.fileId, "fileId"),
          ),
        };
        return json(body);
      },
    },
    {
      method: "PUT",
      path: "/api/projects/:id/knowledge/files/:fileId",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const fileId = parseId(ctx.params.fileId, "fileId");
        const request = parseReplace(await jsonBody(req, MAX_KNOWLEDGE_BODY));
        const body: KnowledgeFileResponse = {
          file: deps.knowledge.replace(
            project.id,
            author(ctx.principal!),
            fileId,
            request.text,
            request.revision,
          ),
        };
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id/knowledge/files/:fileId",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        deps.knowledge.remove(
          project.id,
          author(ctx.principal!),
          parseId(ctx.params.fileId, "fileId"),
        );
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id/knowledge/files/:fileId/versions",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: KnowledgeVersionsResponse = {
          versions: deps.knowledge.versions(
            project.id,
            parseId(ctx.params.fileId, "fileId"),
          ),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id/knowledge/versions/:versionId",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: KnowledgeVersionDetailResponse = {
          version: deps.knowledge.version(
            project.id,
            parseId(ctx.params.versionId, "versionId"),
          ),
        };
        return json(body);
      },
    },
  ];
}
