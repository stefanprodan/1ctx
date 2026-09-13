// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The week's usage for the card on Home: what the caller's visible
// projects spent over the past seven days, the window from the
// composed clock so a test drives it. Which projects is access's
// call, through a port, since access is built after this area.

import type { WeekUsageResponse } from "../../shared/api/usage.ts";
import type { Clock } from "../lib/clock.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseWeekUsageQuery } from "./parse.ts";
import type { UsageStore } from "./store.ts";

const WEEK_MS = 7 * 86_400_000;

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
      path: "/api/usage/week",
      policy: "authenticated",
      handle(_req, ctx) {
        parseWeekUsageQuery(ctx.url);
        const since = deps.clock() - WEEK_MS;
        const projectIds =
          deps.access.visibleProjectIds(ctx.principal!.userId) ?? [];
        const body: WeekUsageResponse = {
          since,
          ...deps.store.week(projectIds, since),
        };
        return json(body);
      },
    },
  ];
}
