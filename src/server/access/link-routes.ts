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
  confirmEmail(id: string): void;
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
// the token is in the page's address; nothing it loads may carry it on
const NO_REFERRER = { "referrer-policy": "no-referrer" };

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
  const gone = () => json({ error: GONE }, 404, NO_REFERRER);
  return [
    ask("reset"),
    ask("signin"),
    {
      method: "GET",
      path: "/api/links/:token",
      policy: "public",
      handle(_req, ctx) {
        const token = ctx.params.token;
        if (!isLinkToken(token)) return gone();
        const link = deps.store.byTokenHash(sha256(token));
        const user = link === null ? null : deps.users.byId(link.userId);
        if (
          link === null ||
          link.usedAt !== null ||
          link.expiresAt <= deps.clock() ||
          user === null ||
          user.disabled
        ) {
          return gone();
        }
        const body: LinkResponse = {
          purpose: link.purpose,
          username: user.username,
        };
        return json(body, 200, NO_REFERRER);
      },
    },
    {
      method: "POST",
      path: "/api/links/:token",
      policy: "public",
      async handle(req, ctx) {
        deps.guard(ctx);
        const token = ctx.params.token;
        const { password } = parseLinkUse(await jsonBody(req));
        if (!isLinkToken(token)) return gone();
        const tokenHash = sha256(token);
        // read first only to know whether to hash; the write decides
        const seen = deps.store.byTokenHash(tokenHash);
        if (seen === null) return gone();
        const sets = seen.purpose !== "signin";
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
            if (used.purpose === "invite") deps.users.confirmEmail(user.id);
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
        return json(body, 200, {
          ...NO_REFERRER,
          "set-cookie": opened.setCookie,
        });
      },
    },
  ];
}
