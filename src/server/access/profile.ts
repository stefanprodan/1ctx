// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user's own page: read it, change the full name, the
// about text and the time zone, change the password. A password change proves the current
// one first, then revokes every other login of the user, so a stolen
// cookie dies with the old password while the tab that changed it stays
// signed in. The proof is rate limited per user, since a signed-in thief
// could otherwise guess at the current password for as long as they
// liked. A wrong guess is a 403, never a 401: the login behind the
// request is fine, and a 401 would sign the tab out.

import type { ProfileResponse } from "../../shared/api/profile.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Forbidden, TooManyRequests, Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import {
  hashPassword,
  profile,
  type UserRow,
  verifyPassword,
} from "../users/index.ts";
import { parsePasswordChange, parseProfile } from "./parse.ts";
import { RateLimit } from "./ratelimit.ts";
import type { LoginStore } from "./store.ts";

export const PASSWORD_LIMIT = 5;
export const PASSWORD_WINDOW_MS = 60 * 1000;

export type UsersPort = {
  byId(id: string): UserRow | null;
  setDetails(id: string, fields: { fullName: string; about: string }): void;
  setTz(id: string, tz: string): void;
  setPasswordHash(id: string, hash: string): void;
  setMustChangePassword(id: string, required: boolean): void;
};

export type ProfileDeps = {
  db: Db;
  logins: LoginStore;
  users: UsersPort;
  clock: Clock;
  log: Log;
};

export function profileRoutes(deps: ProfileDeps): RouteDescriptor[] {
  const limit = new RateLimit(PASSWORD_LIMIT, PASSWORD_WINDOW_MS);
  // the row behind the principal; gone only in the race with a delete
  const self = (id: string): UserRow => {
    const user = deps.users.byId(id);
    if (user === null) throw new Unauthorized("signed out");
    return user;
  };
  return [
    {
      method: "GET",
      path: "/api/profile",
      policy: "authenticated",
      passwordChange: true,
      handle(_req, ctx) {
        const body: ProfileResponse = {
          user: profile(self(ctx.principal!.userId)),
        };
        return json(body);
      },
    },
    {
      method: "PATCH",
      path: "/api/profile",
      policy: "authenticated",
      passwordChange: true,
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
        const body: ProfileResponse = { user: profile(user) };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/profile/password",
      policy: "authenticated",
      passwordChange: true,
      async handle(req, ctx) {
        const principal = ctx.principal!;
        if (!limit.hit(principal.userId, deps.clock())) {
          throw new TooManyRequests("too many attempts; wait a minute");
        }
        const { current, next } = parsePasswordChange(await jsonBody(req));
        const user = self(principal.userId);
        const wrong = new Forbidden("the current password is wrong");
        if (!(await verifyPassword(current, user.passwordHash))) throw wrong;
        const hash = await hashPassword(next);
        const updated = transact(deps.db, () => {
          // the proof was against the hash read before the awaits; two
          // changes racing with the same current password would otherwise
          // both pass, and the second would revoke the first tab's login
          if (self(user.id).passwordHash !== user.passwordHash) throw wrong;
          deps.users.setPasswordHash(user.id, hash);
          deps.users.setMustChangePassword(user.id, false);
          const revoked = deps.logins.deleteOthers(user.id, principal.loginId);
          return {
            result: self(user.id),
            events:
              revoked > 0
                ? [
                    {
                      type: "login.revoked" as const,
                      data: { userId: user.id, loginId: null },
                    },
                  ]
                : [],
          };
        });
        deps.log(`${user.username} changed their password`);
        const body: ProfileResponse = { user: profile(updated) };
        return json(body);
      },
    },
  ];
}
