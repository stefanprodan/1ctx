// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one place access is enforced; an upgrade counts as a write, since
// a browser sends Origin on the handshake.

import { isIP } from "node:net";
import { BadRequest, HttpError } from "../lib/errors.ts";
import {
  json,
  type Method,
  type Principal,
  type RouteDescriptor,
  type RouteOutcome,
} from "../lib/http.ts";
import { errorFields, type Log, type LogFields } from "../lib/log.ts";

type Compiled = RouteDescriptor & { pattern: RegExp; names: string[] };

// what serve() gives an upgrade route: Bun's upgrade with the data and
// the handshake headers; true once Bun holds the connection
export type Upgrader = (
  data: unknown,
  headers: Record<string, string>,
) => boolean;

export type Router = (
  req: Request,
  address: string,
  upgrader?: Upgrader,
) => Promise<RouteOutcome>;

export type Resolver = (req: Request) => {
  principal: Principal | null;
  setCookie: string | null;
};

export type RouterDeps = {
  routes: RouteDescriptor[];
  resolve: Resolver;
  // behind a TLS-terminating proxy the request arrives as http; the
  // proxy's X-Forwarded-Proto says what the browser saw
  trustProxy: boolean;
  log: Log;
};

export function compile(route: RouteDescriptor): Compiled {
  const names: string[] = [];
  const source = route.path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { ...route, pattern: new RegExp(`^${source}$`), names };
}

// two patterns of one method that could match the same path: equal, or
// a parameter opposite a literal in every differing position
export function conflicts(routes: RouteDescriptor[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i];
      const b = routes[j];
      if (a.method !== b.method) continue;
      const as = a.path.split("/");
      const bs = b.path.split("/");
      if (as.length !== bs.length) continue;
      const overlap = as.every(
        (s, k) => s === bs[k] || s.startsWith(":") || bs[k].startsWith(":"),
      );
      if (overlap) out.push(`${a.method} ${a.path} overlaps ${b.path}`);
    }
  }
  return out;
}

// the value the trusted proxy appended last to a comma-joined header;
// anything before it may have come from the client
export function lastForwarded(req: Request, name: string): string | null {
  const value = req.headers.get(name);
  if (value === null) return null;
  const last = value.split(",").pop()?.trim();
  return last ? last : null;
}

// a browser sends Origin on every non-GET; a request without one is not
// from a page, and one from another host or a plaintext page of the
// same host is refused
export function sameOrigin(req: Request, url: URL, trustProxy: boolean) {
  const origin = req.headers.get("origin");
  if (origin === null) return req.headers.get("sec-fetch-site") === null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host !== url.host) return false;
  const forwarded = trustProxy ? lastForwarded(req, "x-forwarded-proto") : null;
  const scheme = forwarded ? `${forwarded}:` : url.protocol;
  return parsed.protocol === scheme || parsed.protocol === "https:";
}

// the policy, the parameters and the handler; every expected outcome is
// a Response. Anything else reaches the request boundary as a bug.
async function dispatch(
  route: Compiled,
  match: RegExpExecArray,
  principal: Principal | null,
  ctx: {
    req: Request;
    url: URL;
    address: string;
    upgrade?: (data: unknown) => boolean;
  },
): Promise<RouteOutcome> {
  if (route.policy === "authenticated" || route.policy === "admin") {
    if (principal === null) return json({ error: "sign in" }, 401);
    if (route.policy === "admin" && principal.role !== "admin") {
      return json({ error: "forbidden" }, 403);
    }
    if (principal.mustChangePassword && route.passwordChange !== true) {
      return json({ error: "change your password first" }, 403);
    }
  }
  try {
    const params: Record<string, string> = {};
    route.names.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(match[i + 1]);
      } catch {
        throw new BadRequest(`malformed ${name} in path`);
      }
    });
    return await route.handle(ctx.req, {
      principal,
      params,
      url: ctx.url,
      address: ctx.address,
      ...(ctx.upgrade ? { upgrade: ctx.upgrade } : {}),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    throw err;
  }
}

// a probe asks every few seconds and never says anything in the log
const PROBES = new Set(["/api/health", "/api/ready"]);

export function router(deps: RouterDeps): Router {
  const clashes = conflicts(deps.routes);
  if (clashes.length > 0) throw new Error(`routes: ${clashes.join("; ")}`);
  const compiled = deps.routes.map(compile);
  return async (req, address, upgrader) => {
    const started = performance.now();
    const url = new URL(req.url);
    const method = req.method as Method;
    const probe = PROBES.has(url.pathname);
    const record = (
      route: string,
      status: number,
      principal: Principal | null | undefined,
      error?: unknown,
    ): void => {
      if (probe) return;
      // a 5xx is our bug whoever asked; below that only a signed-in user's
      // requests say anything, since our client never calls a missing route
      // or writes cross-origin, and a scanner's 4xx would fill the disk
      if (status < 500) {
        if (principal === null || principal === undefined) return;
        if (method === "GET" && status < 400) return;
      }
      const details = error === undefined ? {} : errorFields(error);
      const { status: _errorStatus, ...withoutErrorStatus } = details;
      const fields: LogFields = {
        method,
        route,
        status,
        duration: performance.now() - started,
        user:
          principal === undefined
            ? undefined
            : principal === null
              ? "nobody"
              : principal.username,
        addr: isIP(address) === 0 ? "invalid" : address,
        ...withoutErrorStatus,
      };
      if (error === undefined) deps.log.info("request", fields);
      else deps.log.error("request", fields);
    };
    let pathMatched = false;
    for (const route of compiled) {
      const match = route.pattern.exec(url.pathname);
      if (match === null) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      if (
        (method !== "GET" || route.upgrade) &&
        !sameOrigin(req, url, deps.trustProxy)
      ) {
        const res = json({ error: "cross-origin request" }, 403);
        record(route.path, res.status, undefined);
        return res;
      }
      const resolves = route.policy !== "webhook";
      let resolution: ReturnType<Resolver>;
      try {
        resolution = resolves
          ? deps.resolve(req)
          : { principal: null, setCookie: null };
      } catch (error) {
        const res = json({ error: "internal error" }, 500);
        record(route.path, res.status, undefined, error);
        return res;
      }
      const upgrade =
        route.upgrade && upgrader
          ? (data: unknown) =>
              upgrader(
                data,
                resolution.setCookie === null
                  ? {}
                  : { "set-cookie": resolution.setCookie },
              )
          : undefined;
      let res: RouteOutcome;
      let unexpected: unknown;
      try {
        res = await dispatch(route, match, resolution.principal, {
          req,
          url,
          address,
          upgrade,
        });
      } catch (error) {
        unexpected = error;
        res = json({ error: "internal error" }, 500);
      }
      if (res === undefined) return undefined;
      // the row already moved, so the browser's copy must move with it
      // whatever the answer was, unless the handler replaced the cookie
      if (resolution.setCookie !== null && !res.headers.has("set-cookie")) {
        res.headers.set("set-cookie", resolution.setCookie);
      }
      record(
        route.path,
        res.status,
        resolves ? resolution.principal : undefined,
        unexpected,
      );
      return res;
    }
    const res = json(
      { error: pathMatched ? "method not allowed" : "not found" },
      pathMatched ? 405 : 404,
    );
    record("unmatched", res.status, undefined);
    return res;
  };
}
