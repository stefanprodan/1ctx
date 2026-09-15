// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page, for every signed-in user: one server is one team, so
// anyone may see who a teammate is, their email and their zone. The
// projects listed are the team projects both are members of; an admin's
// view of every team does not count, and a personal project is never
// listed.

import type { DirectoryUserResponse } from "../../shared/api/directory.ts";
import type { ProjectSummary } from "../../shared/contracts/project.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { summary, type UserRow } from "../users/index.ts";
import { parseUsername } from "./parse.ts";

export type UsersPort = {
  byUsername(username: string): UserRow | null;
};

export type ProjectsPort = {
  memberProjectIds(userId: string): string[];
  visibleFor(userId: string, admin: boolean): ProjectSummary[];
};

export type DirectoryDeps = {
  users: UsersPort;
  projects: ProjectsPort;
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
          .filter((p) => p.kind === "team" && theirs.has(p.id));
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
  ];
}
