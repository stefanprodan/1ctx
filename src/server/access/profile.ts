// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// the signed-in user's own page and email from agents

import type { ProfileResponse } from "../../shared/api/profile.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { profile, type UserRow } from "../users/index.ts";
import { parseEmailSettings, parseProfile } from "./parse.ts";

export type UsersPort = {
  byId(id: string): UserRow | null;
  setDetails(id: string, fields: { fullName: string; about: string }): void;
  setTz(id: string, tz: string): void;
  setEmailFromAgents(id: string, on: boolean): void;
};

export type ProfileDeps = {
  db: Db;
  users: UsersPort;
  // the page offers the switch only while email is on
  email: { enabled(): boolean };
};

export function profileRoutes(deps: ProfileDeps): RouteDescriptor[] {
  // the row behind the principal; gone only in the race with a delete
  const self = (id: string): UserRow => {
    const user = deps.users.byId(id);
    if (user === null) throw new Unauthorized("signed out");
    return user;
  };
  const answer = (user: UserRow): ProfileResponse => ({
    user: profile(user),
    emailOn: deps.email.enabled(),
  });
  return [
    {
      method: "GET",
      path: "/api/profile",
      policy: "authenticated",
      handle(_req, ctx) {
        const body = answer(self(ctx.principal!.userId));
        return json(body);
      },
    },
    {
      method: "PATCH",
      path: "/api/profile",
      policy: "authenticated",
      async handle(req, ctx) {
        const details = parseProfile(await jsonBody(req));
        const id = ctx.principal!.userId;
        const user = transact(deps.db, () => {
          deps.users.setDetails(id, {
            fullName: details.fullName,
            about: details.about,
          });
          deps.users.setTz(id, details.tz);
          return { result: self(id) };
        });
        const body = answer(user);
        return json(body);
      },
    },
    {
      method: "PUT",
      path: "/api/profile/email",
      policy: "authenticated",
      async handle(req, ctx) {
        const { fromAgents } = parseEmailSettings(await jsonBody(req));
        const id = ctx.principal!.userId;
        const user = transact(deps.db, () => {
          deps.users.setEmailFromAgents(id, fromAgents);
          return { result: self(id) };
        });
        return json(answer(user));
      },
    },
  ];
}
