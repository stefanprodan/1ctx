// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Login, logout and me. Login is rate limited per address and answers a
// wrong username and a wrong password the same way, after the same hash
// work, so neither leaks which one was wrong. The sign-in field takes a
// username or an email.

import { isIP } from "node:net";
import type { LoginResponse, MeResponse } from "../../shared/api/access.ts";
import type { Me } from "../../shared/contracts/user.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { loginRevoked } from "../lib/bus.ts";
import { type Clock, MINUTE_MS } from "../lib/clock.ts";
import { TooManyRequests, Unauthorized } from "../lib/errors.ts";
import {
  json,
  type Principal,
  type RouteContext,
  type RouteDescriptor,
} from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { meOf, type UserRow, verifyPassword } from "../users/index.ts";
import type { Auth } from "./auth.ts";
import { byLoginName } from "./links.ts";
import { parseLogin } from "./parse.ts";
import { RateLimit } from "./ratelimit.ts";

export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = MINUTE_MS;

const meOfPrincipal = (p: Principal): Me => ({
  id: p.userId,
  username: p.username,
  fullName: p.fullName,
  role: p.role,
  mustChangePassword: p.mustChangePassword,
});

export type UsersPort = {
  byUsername(username: string): UserRow | null;
  byEmail(email: string): UserRow | null;
  nobodyHash(): Promise<string>;
};

export type RoutesDeps = {
  db: Db;
  auth: Auth;
  users: UsersPort;
  clock: Clock;
  log: Log;
  guard(ctx: RouteContext): void;
  // the sign-in page offers the email links
  email: { enabled(): boolean };
};

// the per-address limit of every sign-in route: a login, an ask for a
// link and a link used share one window
export function loginGuard(
  clock: Clock,
  log: Log,
): (ctx: RouteContext) => void {
  const limit = new RateLimit(LOGIN_LIMIT, LOGIN_WINDOW_MS);
  return (ctx) => {
    if (limit.hit(ctx.address, clock())) return;
    if (limit.closed(ctx.address)) {
      log.warn("login limited", {
        addr: isIP(ctx.address) === 0 ? "invalid" : ctx.address,
      });
    }
    throw new TooManyRequests("too many sign-in attempts. Wait a minute");
  };
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "POST",
      path: "/api/login",
      policy: "public",
      async handle(req, ctx) {
        const addr = isIP(ctx.address) === 0 ? "invalid" : ctx.address;
        deps.guard(ctx);
        const { username, password } = parseLogin(await jsonBody(req));
        const user = byLoginName(deps.users, username);
        const ok = await verifyPassword(
          password,
          user?.passwordHash ?? (await deps.users.nobodyHash()),
        );
        const wrong = new Unauthorized("wrong username or password");
        const logFailure = () => deps.log.warn("login failed", { addr });
        if (!ok || user === null || user.disabled) {
          logFailure();
          throw wrong;
        }
        const opened = transact(deps.db, () => {
          // Password verification yields. Re-read under the write transaction so
          // a disable, reset or rename that won meanwhile cannot open a login.
          const current = byLoginName(deps.users, username);
          if (
            current === null ||
            current.id !== user.id ||
            current.passwordHash !== user.passwordHash ||
            current.disabled
          ) {
            logFailure();
            throw wrong;
          }
          const { setCookie } = deps.auth.open(current);
          return { result: { user: current, setCookie } };
        });
        deps.log.info("login opened", { user: opened.user.username });
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
          events: [loginRevoked(principal.userId, principal.loginId)],
        }));
        deps.log.info("login closed", { user: principal.username });
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
          user: p ? meOfPrincipal(p) : null,
          emailOn: deps.email.enabled(),
        };
        return json(body);
      },
    },
  ];
}
