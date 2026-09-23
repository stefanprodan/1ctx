// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  OverviewRange,
  OverviewResponse,
  StorageResponse,
} from "../../shared/api/admin.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseOverviewQuery, parseStorageQuery } from "./parse.ts";

export type RoutesDeps = {
  storage(timeZone: string): Promise<StorageResponse>;
  overview(timeZone: string, days: OverviewRange): Promise<OverviewResponse>;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/overview",
      policy: "admin",
      async handle(_req, ctx) {
        const { timeZone, days } = parseOverviewQuery(ctx.url);
        return json(await deps.overview(timeZone, days));
      },
    },
    {
      method: "GET",
      path: "/api/admin/storage",
      policy: "admin",
      async handle(_req, ctx) {
        const timeZone = parseStorageQuery(ctx.url);
        return json(await deps.storage(timeZone));
      },
    },
  ];
}
