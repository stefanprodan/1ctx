// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  LoadResponse,
  OverviewResponse,
  StorageResponse,
} from "../../shared/api/admin.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseLoadQuery, parseZoneQuery } from "./parse.ts";

export type RoutesDeps = {
  storage(timeZone: string): Promise<StorageResponse>;
  overview(timeZone: string): Promise<OverviewResponse>;
  load(): LoadResponse;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/overview",
      policy: "admin",
      async handle(_req, ctx) {
        return json(await deps.overview(parseZoneQuery(ctx.url)));
      },
    },
    {
      method: "GET",
      path: "/api/admin/storage",
      policy: "admin",
      async handle(_req, ctx) {
        return json(await deps.storage(parseZoneQuery(ctx.url)));
      },
    },
    {
      method: "GET",
      path: "/api/admin/load",
      policy: "admin",
      handle(_req, ctx) {
        parseLoadQuery(ctx.url);
        return json(deps.load());
      },
    },
  ];
}
