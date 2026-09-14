// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Usage summaries for the cards, both in calendar days of the caller's
// zone: the last seven for the aside and 53 ISO weeks for the heatmap. Which projects is access's call,
// through a port, since access is built after this area.

import type {
  DaysUsageResponse,
  WeekUsageResponse,
} from "../../shared/api/usage.ts";
import type { Clock } from "../lib/clock.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseDaysUsageQuery, parseWeekUsageQuery } from "./parse.ts";
import type { UsageStore } from "./store.ts";
import { usageWindow, weekWindow } from "./window.ts";

export type AccessPort = {
  visibleProjectIds(userId: string): string[] | null;
};

export type RoutesDeps = {
  clock: Clock;
  store: UsageStore;
  access: AccessPort;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/usage/days",
      policy: "authenticated",
      handle(_req, ctx) {
        const { timeZone, weeks } = parseDaysUsageQuery(ctx.url);
        const { days, starts, since, until } = usageWindow(
          deps.clock(),
          timeZone,
          weeks,
        );
        const projectIds =
          deps.access.visibleProjectIds(ctx.principal!.userId) ?? [];
        const body: DaysUsageResponse = {
          since,
          until,
          days,
          ...deps.store.days(projectIds, starts, until),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/usage/week",
      policy: "authenticated",
      handle(_req, ctx) {
        const timeZone = parseWeekUsageQuery(ctx.url);
        const { since, until } = weekWindow(deps.clock(), timeZone);
        const projectIds =
          deps.access.visibleProjectIds(ctx.principal!.userId) ?? [];
        const body: WeekUsageResponse = {
          since,
          until,
          ...deps.store.week(projectIds, since, until),
        };
        return json(body);
      },
    },
  ];
}
