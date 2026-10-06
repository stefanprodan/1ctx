// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// the signed-in user's own page, password change and email from agents

import type { ProfileResponse } from "../../shared/api/profile.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { loginRevoked } from "../lib/bus.ts";
import { type Clock, MINUTE_MS } from "../lib/clock.ts";
import { Forbidden, TooManyRequests, Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { profile, type UserRow, verifyPassword } from "../users/index.ts";
import type { Links } from "./links.ts";
import {
  parseEmailSettings,
  parsePasswordChange,
  parseProfile,
} from "./parse.ts";
import { RateLimit } from "./ratelimit.ts";
import type { LoginStore } from "./store.ts";

export const PASSWORD_LIMIT = 5;
export const PASSWORD_WINDOW_MS = MINUTE_MS;

export type UsersPort = {
  byId(id: string): UserRow | null;
  setDetails(id: string, fields: { fullName: string; about: string }): void;
  setTz(id: string, tz: string): void;
  setPasswordHash(id: string, hash: string): void;
  hashPassword(password: string): Promise<string>;
  setMustChangePassword(id: string, required: boolean): void;
  setEmailFromAgents(id: string, on: boolean): void;
};

export type ProfileDeps = {
  db: Db;
  logins: LoginStore;
  users: UsersPort;
  links: Pick<Links, "revoke" | "notice">;
  // the page offers the switch only while email is on
  email: { enabled(): boolean };
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
  const answer = (user: UserRow): ProfileResponse => ({
    user: profile(user),
    emailOn: deps.email.enabled(),
  });
  return [
    {
      method: "GET",
      path: "/api/profile",
      policy: "authenticated",
      passwordChange: true,
      handle(_req, ctx) {
        const body = answer(self(ctx.principal!.userId));
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
    {
      method: "POST",
      path: "/api/profile/password",
      policy: "authenticated",
      passwordChange: true,
      async handle(req, ctx) {
        const principal = ctx.principal!;
        if (!limit.hit(principal.userId, deps.clock())) {
          throw new TooManyRequests("too many attempts. Wait a minute");
        }
        const { current, next } = parsePasswordChange(await jsonBody(req));
        const user = self(principal.userId);
        const wrong = new Forbidden("the current password is wrong");
        if (!(await verifyPassword(current, user.passwordHash))) throw wrong;
        const hash = await deps.users.hashPassword(next);
        const updated = transact(deps.db, () => {
          // the proof was against the hash read before the awaits; two
          // changes racing with the same current password would otherwise
          // both pass, and the second would revoke the first tab's login
          if (self(user.id).passwordHash !== user.passwordHash) throw wrong;
          deps.users.setPasswordHash(user.id, hash);
          deps.users.setMustChangePassword(user.id, false);
          const revoked = deps.logins.deleteOthers(user.id, principal.loginId);
          // a link asked for before the change would undo it
          deps.links.revoke(user.id);
          const changed = self(user.id);
          return {
            result: changed,
            events: [
              ...(revoked > 0 ? [loginRevoked(user.id, null)] : []),
              ...deps.links.notice(changed, "changed", ctx.address),
            ],
          };
        });
        deps.log.info("password changed", { user: user.username });
        const body = answer(updated);
        return json(body);
      },
    },
  ];
}
