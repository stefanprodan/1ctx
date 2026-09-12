// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one route table. Every view is one entry: the path pattern, the
// view, its title, the role it needs, and either a rail entry or hidden.
// The rail and the tests read this; the server enforces access, never
// this table. A view is loaded on first use, so the table stays one
// small module however many views there are; only Login is in the first
// bundle, since App needs it before any route.

import type { IconName } from "../lib/icons.tsx";
import { Login } from "../views/home/Login.tsx";
import { type Lazy, lazy } from "./lazy.ts";

export type Params = Record<string, string>;

export type Route = {
  path: string;
  view: Lazy<{ params: Params }>;
  title: (params: Params) => string;
  role: "public" | "authenticated" | "admin";
  nav?: { label: string; icon: IconName; order: number };
};

export const ROUTES: Route[] = [
  {
    path: "/login",
    view: lazy(async () => Login),
    title: () => "Sign in",
    role: "public",
  },
  {
    path: "/",
    view: lazy(() => import("../views/home/Home.tsx").then((m) => m.Home)),
    title: () => "Home",
    role: "authenticated",
    nav: { label: "Home", icon: "home", order: 1 },
  },
];

export type Match = { route: Route; params: Params };

// the first route whose pattern matches; a :name segment captures one
// path segment. A segment that does not decode matches nothing, so a
// malformed address is a missing page, never a crash.
export function match(pathname: string, routes = ROUTES): Match | null {
  const parts = pathname.split("/");
  for (const route of routes) {
    const pattern = route.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Params = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(":")) {
        try {
          params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          return null;
        }
      } else if (pattern[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

// two patterns that could match one path: equal, or a parameter
// opposite a literal in every differing position. The table test keeps
// this empty, since the first match wins silently.
export function conflicts(routes = ROUTES): string[] {
  const out: string[] = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i].path.split("/");
      const b = routes[j].path.split("/");
      if (a.length !== b.length) continue;
      const overlap = a.every(
        (s, k) => s === b[k] || s.startsWith(":") || b[k].startsWith(":"),
      );
      if (overlap) out.push(`${routes[i].path} overlaps ${routes[j].path}`);
    }
  }
  return out;
}

export function navEntries(role: "admin" | "member", routes = ROUTES) {
  return routes
    .filter((r) => r.nav && (r.role !== "admin" || role === "admin"))
    .sort((a, b) => a.nav!.order - b.nav!.order);
}
