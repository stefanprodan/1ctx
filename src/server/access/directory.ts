// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page, for every signed-in user: one server is one team, so
// anyone may see who a teammate is, their email and their zone. The
// projects listed are the team projects both are members of; an admin's
// view of every team does not count, and a personal project is never
// listed. Their days are their actions in every project as one series,
// whoever asks: posts, chats, manual runs and a signed-in day. The days
// are the person's own, in their zone: a caller who could move the day
// boundary would read, from the differences, what they did each hour.

import type {
  DirectoryUserDaysResponse,
  DirectoryUserResponse,
} from "../../shared/api/directory.ts";
import type { ProjectSummary } from "../../shared/contracts/project.ts";
import type { Clock } from "../lib/clock.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { type UsageWindow, usageWindow } from "../usage/index.ts";
import { summary, type UserRow } from "../users/index.ts";
import { parseNoQuery, parseUsername } from "./parse.ts";
import type { VisitStore } from "./visits.ts";

export type UsersPort = {
  byUsername(username: string): UserRow | null;
};

export type ProjectsPort = {
  memberProjectIds(userId: string): string[];
  visibleFor(userId: string, admin: boolean): ProjectSummary[];
};

// a person's posts, chats and manual runs on each day of a window
export type ActivityPort = {
  personDays(userId: string, starts: number[], until: number): number[];
};

export type DirectoryDeps = {
  users: UsersPort;
  projects: ProjectsPort;
  activity: ActivityPort;
  visits: VisitStore;
  clock: Clock;
};

export function directoryRoutes(deps: DirectoryDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/directory/users/:username",
      policy: "authenticated",
      handle(_req, ctx) {
        const user = deps.users.byUsername(parseUsername(ctx.params.username));
        if (user === null) throw new NotFound("no such user");
        const theirs = new Set(deps.projects.memberProjectIds(user.id));
        const projects = deps.projects
          .visibleFor(ctx.principal!.userId, false)
          .filter((p) => p.kind === "team" && theirs.has(p.id))
          .sort((a, b) => a.name.localeCompare(b.name));
        const body: DirectoryUserResponse = {
          user: {
            ...summary(user),
            email: user.email,
            tz: user.tz,
            about: user.about,
            createdAt: user.createdAt,
            disabled: user.disabled,
          },
          projects,
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/directory/users/:username/days",
      policy: "authenticated",
      handle(_req, ctx) {
        const user = deps.users.byUsername(parseUsername(ctx.params.username));
        if (user === null) throw new NotFound("no such user");
        parseNoQuery(ctx.url);
        let window: UsageWindow;
        try {
          window = usageWindow(deps.clock(), user.tz);
        } catch {
          // a zone the runtime does not know counts in UTC, as a visit does
          window = usageWindow(deps.clock(), "UTC");
        }
        const { days, starts, since, until } = window;
        const usage = deps.activity.personDays(user.id, starts, until);
        // a visit is kept by the person's day, so it lands on that day
        const index = new Map(days.map((day, i) => [day, i]));
        for (const day of deps.visits.days(user.id, days[0]!, days.at(-1)!)) {
          const at = index.get(day);
          if (at !== undefined) usage[at]!++;
        }
        const body: DirectoryUserDaysResponse = {
          since,
          until,
          days,
          // nothing counted spans midnight, so the days sum to it
          total: usage.reduce((sum, n) => sum + n, 0),
          usage,
        };
        return json(body);
      },
    },
  ];
}
