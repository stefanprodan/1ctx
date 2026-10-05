// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// the users list and a user's page; rules in docs/access.md (Users)

import type {
  DirectoryUserDaysResponse,
  DirectoryUserResponse,
  DirectoryUsersResponse,
} from "../../shared/api/directory.ts";
import type { ProjectSummary } from "../../shared/contracts/project.ts";
import { parseNoQuery } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { usageWindow, zoneOrUtc } from "../usage/index.ts";
import { summary, type UserRow } from "../users/index.ts";
import { parseUsername } from "./parse.ts";
import type { VisitStore } from "./visits.ts";

export type UsersPort = {
  byUsername(username: string): UserRow | null;
  list(): UserRow[];
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
      path: "/api/directory/users",
      policy: "authenticated",
      handle(_req, ctx) {
        parseNoQuery(ctx.url);
        const body: DirectoryUsersResponse = {
          users: deps.users
            .list()
            .filter((user) => !user.disabled)
            .map((user) => ({ ...summary(user), tz: user.tz })),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/directory/users/:username",
      policy: "authenticated",
      handle(_req, ctx) {
        const user = deps.users.byUsername(parseUsername(ctx.params.username));
        if (user === null) throw new NotFound("no such user");
        const principal = ctx.principal!;
        const theirs =
          user.role === "admin"
            ? null
            : new Set(deps.projects.memberProjectIds(user.id));
        const projects = deps.projects
          .visibleFor(principal.userId, principal.role === "admin")
          .filter(
            (p) => p.kind === "team" && (theirs === null || theirs.has(p.id)),
          )
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
        const { days, starts, since, until } = usageWindow(
          deps.clock(),
          zoneOrUtc(user.tz),
        );
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
