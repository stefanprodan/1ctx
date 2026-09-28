// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access board's numbers: who signed in over the last 30 days, day
// by day, and which team projects had a turn or a run. A visit counts
// on its user's own date, as the Users page reads it, so the chart and
// the board's Not seen agree however far apart the zones are; the
// days are the reader's last 30. The lists of accounts and projects
// are the users and projects routes'.

import type { AccessBoardResponse } from "../../shared/api/access.ts";
import type { Clock } from "../lib/clock.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { daysWindow, parseZoneQuery } from "../usage/index.ts";
import type { VisitStore } from "./visits.ts";

const BOARD_DAYS = 30;

// "2026-09-28" to "2026-09-29"
const nextDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);

export type BoardUsagePort = {
  activeProjects(ids: string[], since: number, until: number): string[];
};

export type BoardProjectsPort = { teamProjectIds(): string[] };

export type BoardRoutesDeps = {
  visits: VisitStore;
  usage: BoardUsagePort;
  projects: BoardProjectsPort;
  clock: Clock;
};

export function boardRoutes(deps: BoardRoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/access",
      policy: "admin",
      handle(_req, ctx) {
        const timeZone = parseZoneQuery(ctx.url);
        const window = daysWindow(deps.clock(), timeZone, BOARD_DAYS);
        const index = new Map(window.days.map((d, i) => [d, i]));
        const last = window.days.length - 1;
        const users = window.days.map(() => new Set<string>());
        const everyone = new Set<string>();
        // a user east of the reader may already be on the reader's
        // tomorrow: that day is today's bar
        const through = nextDay(window.days[last]!);
        for (const visit of deps.visits.onDays(window.days[0]!, through)) {
          const i = index.get(visit.day) ?? last;
          users[i]!.add(visit.userId);
          everyone.add(visit.userId);
        }
        const body: AccessBoardResponse = {
          since: window.since,
          until: window.until,
          days: window.days.map((label, i) => ({
            day: label,
            start: window.starts[i]!,
            signedIn: users[i]!.size,
          })),
          signedIn: everyone.size,
          activeProjectIds: deps.usage.activeProjects(
            deps.projects.teamProjectIds(),
            window.since,
            window.until,
          ),
        };
        return json(body);
      },
    },
  ];
}
