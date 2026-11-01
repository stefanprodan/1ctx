// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { StagedImageResponse } from "../../shared/api/images.ts";
import { queryParams } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { ID_SHAPE } from "../lib/ids.ts";
import type { ProjectRow } from "../projects/index.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type ImagesPort = {
  stage(
    projectId: string,
    userId: string,
    name: string | null,
    req: Request,
  ): Promise<StagedImageResponse>;
  remove(projectId: string, userId: string, imageId: string): void;
  serve(
    principal: Principal,
    projectId: string,
    imageId: string,
    req: Request,
  ): Response;
};

export type RoutesDeps = { access: AccessPort; images: ImagesPort };

const ID = new RegExp(`^${ID_SHAPE}$`);

export function parseImageId(value: string | undefined): string {
  if (value === undefined || !ID.test(value)) {
    throw new BadRequest("imageId must be an id");
  }
  return value;
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "POST",
      path: "/api/projects/:id/images",
      policy: "authenticated",
      async handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const name = queryParams(ctx.url, ["name"])("name");
        const body = await deps.images.stage(
          project.id,
          ctx.principal!.userId,
          name,
          req,
        );
        return json(body, 201);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id/images/:imageId",
      policy: "authenticated",
      handle(req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        return deps.images.serve(
          ctx.principal!,
          project.id,
          parseImageId(ctx.params.imageId),
          req,
        );
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id/images/:imageId",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        deps.images.remove(
          project.id,
          ctx.principal!.userId,
          parseImageId(ctx.params.imageId),
        );
        return new Response(null, { status: 204 });
      },
    },
  ];
}
