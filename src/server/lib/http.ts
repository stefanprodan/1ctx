// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The vocabulary of a route, owned by nobody: the principal a handler
// receives, the policy the router enforces before it runs, and the
// descriptor an area's routes() returns. Areas import this; web/ imports
// this; neither imports the other for it.

import type { AccessKeyScope } from "../../shared/contracts/access-key.ts";
import type { Role } from "../../shared/words.ts";

// how the principal came in. A login is the row behind the cookie, so
// logout revokes exactly it; a message that starts later has none and
// an empty id. A key is the access key behind a bearer, its scope and
// the projects it narrows the user's to, null for all they see.
export type Via =
  | { kind: "login"; id: string }
  | {
      kind: "key";
      id: string;
      name: string;
      scope: AccessKeyScope;
      projectIds: string[] | null;
    };

// who is asking: resolved by access from the cookie or the bearer,
// checked by the router
export type Principal = {
  userId: string;
  username: string;
  fullName: string;
  role: Role;
  mustChangePassword: boolean;
  via: Via;
};

// the login behind a cookie principal; null for a key, which has none
export const loginOf = (principal: Principal): string | null =>
  principal.via.kind === "login" ? principal.via.id : null;

// public: no principal needed. authenticated: any signed-in user, member
// or admin. admin: the admin role. webhook: no login, a signature
// checked by the handler over the raw body. key: an access key in
// Authorization: Bearer and never the cookie; the cookie policies never
// read a bearer.
export type Policy = "public" | "authenticated" | "admin" | "webhook" | "key";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteContext = {
  // null only under the public and webhook policies; under key, via is
  // a key
  principal: Principal | null;
  // the :name segments of the matched pattern
  params: Record<string, string>;
  url: URL;
  // the client address, for rate limits
  address: string;
  // on an upgrade route served by Bun: hand the connection to the
  // websocket handlers with this data; true once Bun holds it. Absent
  // when the request cannot be upgraded, and the handler answers 426
  upgrade?: (data: unknown) => boolean;
};

// no Response means the connection was upgraded and Bun holds it
export type RouteOutcome = Response | undefined;

export type RouteHandler = (
  req: Request,
  ctx: RouteContext,
) => RouteOutcome | Promise<RouteOutcome>;

export type RouteDescriptor = {
  method: Method;
  // "/api/projects/:id"; a segment starting with ":" captures one segment
  path: string;
  policy: Policy;
  // reachable while the principal must change their password; the router
  // refuses every other authenticated route with 403
  passwordChange?: true;
  // a websocket upgrade: same-origin is checked as for a write, and
  // the handler gets ctx.upgrade
  upgrade?: true;
  // the seconds the connection may sit idle once access passed, for a
  // route that waits on an upstream past Bun's 10 s default; at most
  // MAX_IDLE_SECONDS, Bun's own ceiling
  idleSeconds?: number;
  handle: RouteHandler;
};

export const MAX_IDLE_SECONDS = 255;

export const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
