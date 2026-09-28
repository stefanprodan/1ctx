// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access board's numbers: who signed in over the last 30 days, day
// by day, and which team projects had a turn or a run. A visit counts
// on its user's own date, as the Users page reads it, so the chart and
// the board's Inactive agree however far apart the zones are; the
// days are the reader's last 30. Recent is the ten users seen in them,
// a disabled one left out, the ones with a tab open first, then by
// their latest signed-in request. The lists of accounts and projects
// are the users and projects routes'.

import type {
  AccessBoardResponse,
  AccessRecent,
} from "../../shared/api/access.ts";
import type { Clock } from "../lib/clock.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { daysWindow, parseZoneQuery } from "../usage/index.ts";
import type { LoginStore } from "./store.ts";
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

export type PresencePort = { onlineUserIds(): string[] };

export type BoardUsersPort = { byId(id: string): { disabled: boolean } | null };

export const RECENT_USERS = 10;

export type BoardRoutesDeps = {
  visits: VisitStore;
  logins: LoginStore;
  presence: PresencePort;
  users: BoardUsersPort;
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
          recent: recent(deps, window.since),
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

// A user seen since the window opened, by the newer of their visit and
// their login rows. A visit's instant is the day's first request and a
// login is touched at most hourly, so a user who signed out may read
// hours earlier than their last request. Online while a socket of
// theirs is open. One without a visit is inactive on the board.
function recent(deps: BoardRoutesDeps, since: number): AccessRecent[] {
  const latest = deps.visits.latestAt();
  for (const [userId, at] of deps.logins.latestSeen()) {
    const held = latest.get(userId);
    if (held !== undefined && at > held) latest.set(userId, at);
  }
  const online = new Set(deps.presence.onlineUserIds());
  return [...latest]
    .filter(([userId, at]) => {
      if (at < since && !online.has(userId)) return false;
      const user = deps.users.byId(userId);
      return user !== null && !user.disabled;
    })
    .map(([userId, at]) => ({ userId, at, online: online.has(userId) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || b.at - a.at)
    .slice(0, RECENT_USERS);
}
