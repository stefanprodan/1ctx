// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Asking for a link and its code at the sign-in page, and using either.
// An ask answers 202 before any lookup and sets the browser's
// challenge, which a code is only tried beside. A link never acts on a
// GET, since email scanners open every link: the link page (web/) is
// drawn outside the router and its form's POST is the one write.

import type { CodeResponse } from "../../shared/api/access.ts";
import type { Me } from "../../shared/contracts/user.ts";
import { type Db, transact } from "../db/index.ts";
import { formBody, isForm, jsonBody } from "../lib/body.ts";
import { type BusEvent, loginRevoked } from "../lib/bus.ts";
import { type Clock, MINUTE_MS } from "../lib/clock.ts";
import { BadRequest, NotFound } from "../lib/errors.ts";
import {
  json,
  loginOf,
  type Principal,
  type RouteContext,
  type RouteDescriptor,
} from "../lib/http.ts";
import { newToken, sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import { meOf, type UserRow } from "../users/index.ts";
import type { Auth } from "./auth.ts";
import { cookieValue } from "./auth.ts";
import type { LinkStore, Used } from "./link-store.ts";
import { codeHash, type Links } from "./links.ts";
import { isLinkToken, parseCode, parseLinkAsk, parseLinkUse } from "./parse.ts";

// the asking browser's challenge, which a code is only tried beside
export const ASK_COOKIE = "login_ask";
const ASK_TTL_MS = 15 * MINUTE_MS;
// where a sign-in by link or code lands
export const LANDING = "/";

export type UsersPort = {
  byId(id: string): UserRow | null;
  byEmail(email: string): UserRow | null;
};

// the server-drawn pages a form post answers with (web/link-page.ts)
export type PagesPort = {
  // a dead link, read as an unknown one
  dead(): Response;
  // the answer to a form's ask, with these headers
  sent(headers: Record<string, string>): Response;
};

export type LinkRoutesDeps = {
  db: Db;
  auth: Auth;
  store: LinkStore;
  links: Links;
  users: UsersPort;
  email: { enabled(): boolean };
  pages: PagesPort;
  clock: Clock;
  log: Log;
  secureCookie: boolean;
  // the login route's per-address limit, shared
  guard(ctx: RouteContext): void;
};

// newToken()'s shape, as the cookie must hold
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function askChallenge(req: Request): string | null {
  const value = cookieValue(req, ASK_COOKIE);
  return value !== null && CHALLENGE.test(value) ? value : null;
}

// whether a token opens a live link: unused, unexpired, its user enabled
export function linkLive(
  store: LinkStore,
  users: Pick<UsersPort, "byId">,
  now: number,
  token: string,
): boolean {
  if (!isLinkToken(token)) return false;
  const link = store.byTokenHash(sha256(token));
  if (link === null || link.usedAt !== null || link.expiresAt <= now) {
    return false;
  }
  const user = users.byId(link.userId);
  return user !== null && !user.disabled;
}

export function linkRoutes(deps: LinkRoutesDeps): RouteDescriptor[] {
  // a browser that asked before keeps its challenge, so its earlier
  // link's code still works here
  const askCookie = (challenge: string) =>
    `${ASK_COOKIE}=${challenge}; Path=/api/login; HttpOnly; SameSite=Lax; Max-Age=${ASK_TTL_MS / 1000}${deps.secureCookie ? "; Secure" : ""}`;

  // the one transaction a link and a code share: the use, the browser's
  // previous login ended, a login opened and the notice queued
  const signIn = (
    principal: Principal | null,
    address: string,
    by: "link" | "code",
    use: () => Used | null,
  ): { me: Me; setCookie: string } | null => {
    const opened = transact(deps.db, () => {
      const used = use();
      if (used === null) return { result: null };
      const user = deps.users.byId(used.userId)!;
      const events: BusEvent[] = [];
      // the tab's login is replaced, never kept beside the new one
      const loginId = principal === null ? null : loginOf(principal);
      if (principal !== null && loginId !== null) {
        deps.auth.close(loginId);
        events.push(loginRevoked(principal.userId, loginId));
      }
      const { setCookie } = deps.auth.open(user, null);
      if (used.purpose === "signin") {
        events.push(...deps.links.notice(user, by, address));
      }
      return {
        result: { user, purpose: used.purpose, setCookie },
        events,
      };
    });
    if (opened === null) return null;
    deps.log.info("link used", {
      user: opened.user.username,
      purpose: opened.purpose,
      by,
    });
    return { me: meOf(opened.user), setCookie: opened.setCookie };
  };

  // a code against every live link of the address beside this
  // challenge, and every invite's: a hit uses that one, a miss counts on
  // all of them. Inside signIn's transaction, so the misses commit
  const useCode = (userId: string, challenge: string, code: string) => {
    const now = deps.clock();
    const tried = deps.store.tried(userId, sha256(challenge), now);
    const hit = tried.find((l) => l.code_hash === codeHash(l.id, code));
    if (hit !== undefined) return deps.store.use("id", hit.id, now);
    for (const l of tried) deps.store.miss(l.id, l.asked === 1, now);
    return null;
  };

  // unknown, used, expired or its user disabled: the dead page
  const live = (token: string) =>
    linkLive(deps.store, deps.users, deps.clock(), token);

  return [
    {
      method: "POST",
      path: "/api/login/link",
      policy: "public",
      formPost: true,
      async handle(req, ctx) {
        if (!deps.email.enabled()) throw new NotFound("email is not set up");
        deps.guard(ctx);
        const form = isForm(req);
        const { email } = parseLinkAsk(
          form ? await formBody(req) : await jsonBody(req),
        );
        const challenge = askChallenge(req) ?? newToken();
        deps.links.ask(email, challenge);
        const headers = {
          "cache-control": "no-store",
          "set-cookie": askCookie(challenge),
        };
        return form
          ? deps.pages.sent(headers)
          : new Response(null, { status: 202, headers });
      },
    },
    {
      method: "POST",
      path: "/api/login/code",
      policy: "public",
      async handle(req, ctx) {
        deps.guard(ctx);
        // a wrong code, another address, no challenge and a bad body
        // are one answer; a body past the cap keeps its 413
        const wrong = () => json({ error: "wrong code" }, 401);
        let email: string;
        let code: string;
        try {
          ({ email, code } = parseCode(await jsonBody(req)));
        } catch (error) {
          if (error instanceof BadRequest) return wrong();
          throw error;
        }
        const challenge = askChallenge(req);
        const user = challenge === null ? null : deps.users.byEmail(email);
        if (challenge === null || user === null) return wrong();
        const opened = signIn(ctx.principal, ctx.address, "code", () =>
          useCode(user.id, challenge, code),
        );
        if (opened === null) return wrong();
        const body: CodeResponse = { user: opened.me, landing: LANDING };
        return json(body, 200, { "set-cookie": opened.setCookie });
      },
    },
    {
      method: "POST",
      path: "/api/links/:token",
      policy: "public",
      formPost: true,
      async handle(req, ctx) {
        deps.guard(ctx);
        const token = ctx.params.token;
        // a dead link answers as an unknown one, before the body is
        // read; the write below still decides
        if (!live(token)) return deps.pages.dead();
        parseLinkUse(await formBody(req));
        const opened = signIn(ctx.principal, ctx.address, "link", () =>
          deps.store.use("token", sha256(token), deps.clock()),
        );
        if (opened === null) return deps.pages.dead();
        return new Response(null, {
          status: 303,
          headers: {
            location: LANDING,
            "cache-control": "no-store",
            "set-cookie": opened.setCookie,
          },
        });
      },
    },
  ];
}
