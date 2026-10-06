// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Asking for a link at the sign-in page, and using one. An ask answers
// 202 before any lookup. A link never acts on a GET, since email
// scanners open every link; the POST is the one write that uses it.

import type { LinkResponse, LoginResponse } from "../../shared/api/access.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { type BusEvent, loginRevoked } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, NotFound } from "../lib/errors.ts";
import { json, type RouteContext, type RouteDescriptor } from "../lib/http.ts";
import { sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import { meOf, type UserRow } from "../users/index.ts";
import type { Auth } from "./auth.ts";
import type { LinkStore } from "./link-store.ts";
import type { Links } from "./links.ts";
import { isLinkToken, parseLinkAsk, parseLinkUse } from "./parse.ts";
import type { LoginStore } from "./store.ts";

export type UsersPort = {
  byId(id: string): UserRow | null;
  setPasswordHash(id: string, hash: string): void;
  setMustChangePassword(id: string, required: boolean): void;
  hashPassword(password: string): Promise<string>;
};

export type LinkRoutesDeps = {
  db: Db;
  auth: Auth;
  logins: LoginStore;
  store: LinkStore;
  links: Links;
  users: UsersPort;
  email: { enabled(): boolean };
  clock: Clock;
  log: Log;
  // the login route's per-address limit, shared
  guard(ctx: RouteContext): void;
};

// unknown, used, expired or its user disabled: one answer for all
const GONE = "this link is no longer valid";

export function linkRoutes(deps: LinkRoutesDeps): RouteDescriptor[] {
  const ask = (purpose: "reset" | "signin"): RouteDescriptor => ({
    method: "POST",
    path: purpose === "reset" ? "/api/login/forgot" : "/api/login/link",
    policy: "public",
    async handle(req, ctx) {
      if (!deps.email.enabled()) throw new NotFound("email is not set up");
      deps.guard(ctx);
      const { username } = parseLinkAsk(await jsonBody(req));
      deps.links.ask(purpose, username);
      return new Response(null, { status: 202 });
    },
  });
  const gone = () => json({ error: GONE }, 404);
  // the link a token opens while it is live: unused, unexpired and its
  // user enabled; its user beside it
  const live = (token: string) => {
    const link = isLinkToken(token)
      ? deps.store.byTokenHash(sha256(token))
      : null;
    if (link === null || link.usedAt !== null) return null;
    if (link.expiresAt <= deps.clock()) return null;
    const user = deps.users.byId(link.userId);
    if (user === null || user.disabled) return null;
    return { link, user };
  };
  return [
    ask("reset"),
    ask("signin"),
    {
      method: "GET",
      path: "/api/links/:token",
      policy: "public",
      // a dead link is a 200 with null, as /api/me answers nobody, so
      // the page's read puts no failed request in the browser's console
      handle(_req, ctx) {
        const found = live(ctx.params.token);
        const body: LinkResponse = {
          link:
            found === null
              ? null
              : { purpose: found.link.purpose, username: found.user.username },
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/links/:token",
      policy: "public",
      async handle(req, ctx) {
        deps.guard(ctx);
        const token = ctx.params.token;
        // a dead link answers as an unknown one, before the body is read
        // or a password hashed; the write below still decides
        const found = live(token);
        if (found === null) return gone();
        const tokenHash = sha256(token);
        const { password } = parseLinkUse(await jsonBody(req));
        const sets = found.link.purpose !== "signin";
        if (sets && password === undefined) {
          throw new BadRequest("password must be set");
        }
        if (!sets && password !== undefined) {
          throw new BadRequest("password must be left out to sign in");
        }
        const hash =
          password === undefined
            ? null
            : await deps.users.hashPassword(password);
        const principal = ctx.principal;
        const opened = transact(deps.db, () => {
          const used = deps.store.use(tokenHash, deps.clock());
          if (used === null) return { result: null };
          const user = deps.users.byId(used.userId)!;
          const events: BusEvent[] = [];
          // the tab's login is replaced, never kept beside the new one
          if (principal !== null) {
            deps.auth.close(principal.loginId);
            events.push(loginRevoked(principal.userId, principal.loginId));
          }
          if (hash !== null) {
            deps.users.setPasswordHash(user.id, hash);
            deps.users.setMustChangePassword(user.id, false);
            deps.logins.deleteForUser(user.id);
            deps.links.revoke(user.id);
            events.push(loginRevoked(user.id, null));
          }
          const current = deps.users.byId(user.id)!;
          const { setCookie } = deps.auth.open(current);
          if (used.purpose !== "invite") {
            events.push(
              ...deps.links.notice(
                current,
                used.purpose === "reset" ? "reset" : "signin",
                ctx.address,
              ),
            );
          }
          return {
            result: { user: current, purpose: used.purpose, setCookie },
            events,
          };
        });
        if (opened === null) return gone();
        deps.log.info("link used", {
          user: opened.user.username,
          purpose: opened.purpose,
        });
        const body: LoginResponse = { user: meOf(opened.user) };
        return json(body, 200, { "set-cookie": opened.setCookie });
      },
    },
  ];
}
