// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The vocabulary of a route, owned by nobody: the principal a handler
// receives, the policy the router enforces before it runs, and the
// descriptor an area's routes() returns. Areas import this; web/ imports
// this; neither imports the other for it.

import type { Role } from "../../shared/words.ts";

// who is asking: resolved by access from the cookie, checked by the router
export type Principal = {
  userId: string;
  username: string;
  fullName: string;
  role: Role;
  // the login row behind the cookie, so logout can revoke exactly it
  loginId: string;
};

// public: no principal needed. authenticated: any signed-in user, member
// or admin. admin: the admin role. webhook: no login, a signature
// checked by the handler over the raw body.
export type Policy = "public" | "authenticated" | "admin" | "webhook";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteContext = {
  // null only under the public and webhook policies
  principal: Principal | null;
  // the :name segments of the matched pattern
  params: Record<string, string>;
  url: URL;
  // the client address, for rate limits
  address: string;
};

export type RouteHandler = (
  req: Request,
  ctx: RouteContext,
) => Response | Promise<Response>;

export type RouteDescriptor = {
  method: Method;
  // "/api/projects/:id"; a segment starting with ":" captures one segment
  path: string;
  policy: Policy;
  handle: RouteHandler;
};

export const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
