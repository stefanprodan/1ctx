// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Login, logout and me. Login is rate limited per address and answers a
// wrong name and a wrong password the same way, after the same hash
// work, so neither leaks which one was wrong.

import type { LoginResponse, MeResponse } from "../../shared/api/access.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { TooManyRequests, Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { summary, type UserRow, verifyPassword } from "../users/index.ts";
import type { Access } from "./auth.ts";
import { jsonBody, parseLogin } from "./parse.ts";
import { RateLimit } from "./ratelimit.ts";

export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 60 * 1000;

// a hash to verify against when the name is unknown, so the work and the
// time are the same as for a known name
const NOBODY = await Bun.password.hash("nobody", { algorithm: "argon2id" });

export type RoutesDeps = {
  db: Db;
  access: Access;
  // the users port
  userByName: (name: string) => UserRow | null;
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
        const { name, password } = parseLogin(await jsonBody(req));
        const user = deps.userByName(name);
        const ok = await verifyPassword(password, user?.passwordHash ?? NOBODY);
        if (!ok || user === null)
          throw new Unauthorized("wrong name or password");
        const { setCookie } = transact(deps.db, () => ({
          result: deps.access.open(user),
        }));
        deps.log(`${user.name} signed in`);
        const body: LoginResponse = { user: summary(user) };
        return json(body, 200, { "set-cookie": setCookie });
      },
    },
    {
      method: "POST",
      path: "/api/logout",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const cleared = transact(deps.db, () => ({
          result: deps.access.close(principal.loginId),
          events: [
            {
              type: "login.revoked",
              data: { userId: principal.userId, loginId: principal.loginId },
            },
          ],
        }));
        deps.log(`${principal.name} signed out`);
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
          user: p ? { id: p.userId, name: p.name, role: p.role } : null,
        };
        return json(body);
      },
    },
  ];
}
