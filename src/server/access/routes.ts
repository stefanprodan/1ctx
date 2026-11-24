// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Login, logout and me. A login by admin key is rate limited per
// address and answers every failure, a bad body included, with one 401,
// since the page faces the internet.

import { isIP } from "node:net";
import type { LoginResponse, MeResponse } from "../../shared/api/access.ts";
import type { Me } from "../../shared/contracts/user.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { type BusEvent, loginRevoked } from "../lib/bus.ts";
import { type Clock, MINUTE_MS } from "../lib/clock.ts";
import { BadRequest, TooManyRequests, Unauthorized } from "../lib/errors.ts";
import {
  json,
  loginOf,
  type Principal,
  type RouteContext,
  type RouteDescriptor,
} from "../lib/http.ts";
import { sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import { meOf, type UserRow } from "../users/index.ts";
import type { AdminKeys } from "./admin-keys.ts";
import type { Auth } from "./auth.ts";
import { parseLogin } from "./parse.ts";
import { RateLimit } from "./ratelimit.ts";

export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = MINUTE_MS;
// passkey options, per address in the same window: a sign-in page keeps
// them fresh, so they never spend the sign-in limit
export const OPTIONS_LIMIT = 60;

const meOfPrincipal = (p: Principal): Me => ({
  id: p.userId,
  username: p.username,
  fullName: p.fullName,
  role: p.role,
});

export type UsersPort = {
  byUsername(username: string): UserRow | null;
};

export type RoutesDeps = {
  db: Db;
  auth: Auth;
  users: UsersPort;
  adminKeys: Pick<AdminKeys, "match">;
  clock: Clock;
  log: Log;
  guard(ctx: RouteContext): void;
  // the sign-in page offers the email links
  email: { enabled(): boolean };
  dictation: DictationPort;
};

// the composer offers its mic
export type DictationPort = { enabled(): boolean };

// the per-address limit of every sign-in route: a login, an ask for a
// link, a code, a link used and a passkey answer share one window
export function loginGuard(
  clock: Clock,
  log: Log,
  hits = LOGIN_LIMIT,
): (ctx: RouteContext) => void {
  const limit = new RateLimit(hits, LOGIN_WINDOW_MS);
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
        const wrong = () => {
          deps.log.warn("login failed", { addr });
          return new Unauthorized("wrong admin key");
        };
        // a body past the cap keeps its 413, which says nothing of a key
        let key: string;
        try {
          ({ key } = parseLogin(await jsonBody(req)));
        } catch (error) {
          if (error instanceof BadRequest) throw wrong();
          throw error;
        }
        const username = deps.adminKeys.match(key);
        if (username === null) throw wrong();
        const digest = sha256(key);
        const principal = ctx.principal;
        const opened = transact(deps.db, () => {
          const user = deps.users.byUsername(username);
          if (user === null || user.disabled || user.role !== "admin") {
            throw wrong();
          }
          // the tab's login is replaced, never kept beside the new one
          const events: BusEvent[] = [];
          const loginId = principal === null ? null : loginOf(principal);
          if (principal !== null && loginId !== null) {
            deps.auth.close(loginId);
            events.push(loginRevoked(principal.userId, loginId));
          }
          const { setCookie } = deps.auth.open(user, digest);
          return { result: { user, setCookie }, events };
        });
        deps.log.info("login opened", {
          user: opened.user.username,
          by: "key",
        });
        const body: LoginResponse = { user: meOf(opened.user) };
        return json(body, 200, { "set-cookie": opened.setCookie });
      },
    },
    {
      method: "POST",
      path: "/api/logout",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const loginId = loginOf(principal)!;
        const cleared = transact(deps.db, () => ({
          result: deps.auth.close(loginId),
          events: [loginRevoked(principal.userId, loginId)],
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
          dictationOn: p !== null && deps.dictation.enabled(),
        };
        return json(body);
      },
    },
  ];
}
