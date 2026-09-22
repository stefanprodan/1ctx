// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The project-scoped file and history API. Each lookup resolves project
// access first, then addresses rows within that project, so a foreign id
// is indistinguishable from a missing one and deleted history stays readable.

import type {
  EmptyBinResponse,
  KnowledgeFileDetailResponse,
  KnowledgeFileResponse,
  KnowledgeListResponse,
  KnowledgeUploadResult,
  KnowledgeVersionDetailResponse,
  KnowledgeVersionsResponse,
  StagedUploadResponse,
  StagedUploadsResponse,
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
  stageUpload(
    projectId: string,
    userId: string,
    req: Request,
  ): Promise<StagedUploadResponse>;
  listUploads(projectId: string, userId: string): StagedUploadsResponse;
  removeUpload(projectId: string, userId: string, uploadId: string): void;
  upload(
    projectId: string,
    author: KnowledgeAuthor,
    req: Request,
  ): Promise<KnowledgeUploadResult>;
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
  emptyBin(projectId: string): number;
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
      method: "POST",
      path: "/api/projects/:id/uploads",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: StagedUploadResponse = await deps.knowledge.stageUpload(
          project.id,
          ctx.principal!.userId,
          req,
        );
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id/uploads",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: StagedUploadsResponse = deps.knowledge.listUploads(
          project.id,
          ctx.principal!.userId,
        );
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id/uploads/:uploadId",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        deps.knowledge.removeUpload(
          project.id,
          ctx.principal!.userId,
          parseId(ctx.params.uploadId, "uploadId"),
        );
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/knowledge/upload",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: KnowledgeUploadResult = await deps.knowledge.upload(
          project.id,
          author(ctx.principal!),
          req,
        );
        return json(body);
      },
    },
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
      method: "DELETE",
      path: "/api/projects/:id/knowledge/deleted",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: EmptyBinResponse = {
          files: deps.knowledge.emptyBin(project.id),
        };
        return json(body);
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
