// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AttentionResponse,
  LoadResponse,
  OverviewRange,
  OverviewResponse,
  StorageResponse,
  UsageResponse,
} from "../../shared/api/admin.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import {
  parseLoadQuery,
  parseOverviewQuery,
  parseUsageQuery,
  parseZoneQuery,
} from "./parse.ts";

export type RoutesDeps = {
  storage(timeZone: string): Promise<StorageResponse>;
  overview(timeZone: string, range: OverviewRange): Promise<OverviewResponse>;
  usage(timeZone: string, month: string): Promise<UsageResponse>;
  attention(): AttentionResponse;
  load(): LoadResponse;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/overview",
      policy: "admin",
      async handle(_req, ctx) {
        const { timeZone, range } = parseOverviewQuery(ctx.url);
        return json(await deps.overview(timeZone, range));
      },
    },
    {
      method: "GET",
      path: "/api/admin/usage",
      policy: "admin",
      async handle(_req, ctx) {
        const { timeZone, month } = parseUsageQuery(ctx.url);
        return json(await deps.usage(timeZone, month));
      },
    },
    {
      method: "GET",
      path: "/api/admin/attention",
      policy: "admin",
      handle(_req, ctx) {
        parseLoadQuery(ctx.url);
        return json(deps.attention());
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
