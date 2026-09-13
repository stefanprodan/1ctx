// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Login, logout and me. Login is rate limited per address and answers a
// wrong username and a wrong password the same way, after the same hash
// work, so neither leaks which one was wrong.

import type { LoginResponse, MeResponse } from "../../shared/api/access.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { TooManyRequests, Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { meOf, type UserRow, verifyPassword } from "../users/index.ts";
import type { Auth } from "./auth.ts";
import { parseLogin } from "./parse.ts";
import { RateLimit } from "./ratelimit.ts";

export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 60 * 1000;

// a hash to verify against when the name is unknown, so the work and the
// time are the same as for a known name
const NOBODY = await Bun.password.hash("nobody", { algorithm: "argon2id" });

export type UsersPort = {
  byUsername(username: string): UserRow | null;
};

export type RoutesDeps = {
  db: Db;
  auth: Auth;
  users: UsersPort;
  clock: Clock;
  log: Log;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const limit = new RateLimit(LOGIN_LIMIT, LOGIN_WINDOW_MS);
  return [
    {
      method: "POST",
      path: "/api/login",
      policy: "public",
      async handle(req, ctx) {
        if (!limit.hit(ctx.address, deps.clock())) {
          throw new TooManyRequests("too many sign-in attempts; wait a minute");
        }
        const { username, password } = parseLogin(await jsonBody(req));
        const user = deps.users.byUsername(username);
        const ok = await verifyPassword(password, user?.passwordHash ?? NOBODY);
        const wrong = new Unauthorized("wrong username or password");
        if (!ok || user === null || user.disabled) throw wrong;
        const opened = transact(deps.db, () => {
          // Password verification yields. Re-read under the write transaction so
          // a disable, reset or rename that won meanwhile cannot open a login.
          const current = deps.users.byUsername(username);
          if (
            current === null ||
            current.id !== user.id ||
            current.passwordHash !== user.passwordHash ||
            current.disabled
          ) {
            throw wrong;
          }
          const { setCookie } = deps.auth.open(current);
          return { result: { user: current, setCookie } };
        });
        deps.log(`${opened.user.username} signed in`);
        const body: LoginResponse = { user: meOf(opened.user) };
        return json(body, 200, { "set-cookie": opened.setCookie });
      },
    },
    {
      method: "POST",
      path: "/api/logout",
      policy: "authenticated",
      passwordChange: true,
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const cleared = transact(deps.db, () => ({
          result: deps.auth.close(principal.loginId),
          events: [
            {
              type: "login.revoked",
              data: { userId: principal.userId, loginId: principal.loginId },
            },
          ],
        }));
        deps.log(`${principal.username} signed out`);
        return json({ ok: true }, 200, { "set-cookie": cleared });
      },
    },
    {
      // public on purpose: the page asks who is signed in on every load,
      // and "nobody" is an answer, not an error
      method: "GET",
      path: "/api/me",
      policy: "public",
      handle(_req, ctx) {
        const p = ctx.principal;
        const body: MeResponse = {
          user: p
            ? {
                id: p.userId,
                username: p.username,
                fullName: p.fullName,
                role: p.role,
                mustChangePassword: p.mustChangePassword,
              }
            : null,
        };
        return json(body);
      },
    },
  ];
}
