// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one route table. Every view is one entry: the path pattern, the
// view, its title, the role it needs, what it loads, and either a rail
// entry or hidden.
// A rail entry may sit in a group, a row that expands to its entries;
// Admin is the one so far, and only admins get its routes. The rail and
// the tests read this; the server enforces access, never this table.
// A view is loaded on first use, so the table stays one small module
// however many views there are; only Login is in the first bundle,
// since App needs it before any route.

import { loadAdminProjects } from "../data/admin-projects.ts";
import { loadAgents } from "../data/agents.ts";
import { loadProfile } from "../data/profile.ts";
import {
  loadProject,
  loadProjects,
  project,
  projects,
} from "../data/projects.ts";
import { loadProviders } from "../data/providers.ts";
import {
  loadList,
  loadProjectAgents,
  loadSession,
  session,
} from "../data/sessions.ts";
import { loadTools } from "../data/tools.ts";
import { loadWeek } from "../data/usage.ts";
import { loadUsers } from "../data/users.ts";
import type { IconName } from "../lib/icons.tsx";
import { Login } from "../views/home/Login.tsx";
import { type Lazy, lazy } from "./lazy.ts";
import type { Params } from "./params.ts";

export type { Params };

export type Route = {
  path: string;
  view: Lazy<{ params: Params }>;
  title: (params: Params) => string;
  role: "public" | "authenticated" | "admin";
  // what the view reads, started by app/loading.ts when the route
  // matches, with the query for a view filtered by it; a view never
  // fetches
  load?: (params: Params, query: URLSearchParams) => Promise<void>;
  nav?: { label: string; icon: IconName; order: number; group?: string };
};

// the icon of a group's row in the rail
export const GROUP_ICONS: Record<string, IconName> = { Admin: "admin" };

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
    // the stream for the query, and the personal project's agents for
    // the composer; the project comes from the rail's list
    load: async (_params, query) => {
      const q = query.get("q")?.trim() ?? "";
      const rows = loadList({ project: null, q });
      const spent = loadWeek();
      await loadProjects();
      const personal = projects.value?.find((p) => p.kind === "personal");
      await Promise.all([
        rows,
        spent,
        personal === undefined
          ? Promise.resolve()
          : loadProjectAgents(personal.id),
      ]);
    },
    nav: { label: "Home", icon: "home", order: 1 },
  },
  {
    path: "/projects",
    view: lazy(() =>
      import("../views/projects/Projects.tsx").then((m) => m.Projects),
    ),
    title: () => "Projects",
    role: "authenticated",
    load: () => loadProjects(),
    nav: { label: "Projects", icon: "projects", order: 2 },
  },
  {
    path: "/projects/:id",
    view: lazy(() =>
      import("../views/projects/Project.tsx").then((m) => m.Project),
    ),
    title: () => "Project",
    role: "authenticated",
    load: async (params, query) => {
      await Promise.all([
        loadProject(params.id),
        loadList({ project: params.id, q: query.get("q")?.trim() ?? "" }),
        loadProjectAgents(params.id),
      ]);
    },
  },
  {
    path: "/projects/:id/members",
    view: lazy(() =>
      import("../views/projects/Members.tsx").then((m) => m.Members),
    ),
    title: () => "Members",
    role: "authenticated",
    load: async (params) => {
      await Promise.all([loadProject(params.id), loadProjectAgents(params.id)]);
    },
  },
  {
    path: "/chat/:id",
    view: lazy(() => import("../views/sessions/Chat.tsx").then((m) => m.Chat)),
    title: () => "Chat",
    role: "authenticated",
    // the project and the agents follow the session, since only its
    // row says which project it is in
    load: async (params) => {
      await loadSession(params.id);
      const detail = session.value;
      if (detail === null || detail.session.id !== params.id) return;
      const projectId = detail.session.projectId;
      if (project.value?.id !== projectId) await loadProject(projectId);
      await loadProjectAgents(projectId);
    },
  },
  {
    path: "/admin/projects",
    view: lazy(() =>
      import("../views/admin/AdminProjects.tsx").then((m) => m.AdminProjects),
    ),
    title: () => "Projects",
    role: "admin",
    load: async () => {
      await Promise.all([loadAdminProjects(), loadUsers()]);
    },
    nav: { label: "Projects", icon: "projects", order: 8, group: "Admin" },
  },
  {
    path: "/admin/users",
    view: lazy(() => import("../views/admin/Users.tsx").then((m) => m.Users)),
    title: () => "Users",
    role: "admin",
    load: () => loadUsers(),
    nav: { label: "Users", icon: "users", order: 9, group: "Admin" },
  },
  {
    path: "/admin/agents",
    view: lazy(() => import("../views/admin/Agents.tsx").then((m) => m.Agents)),
    title: () => "Agents",
    role: "admin",
    load: async () => {
      // the limits too: the agents page shows where each model compacts
      await Promise.all([loadAgents(), loadProviders(), loadTools()]);
    },
    nav: { label: "Agents", icon: "agents", order: 10, group: "Admin" },
  },
  {
    path: "/admin/tools",
    view: lazy(() => import("../views/admin/Tools.tsx").then((m) => m.Tools)),
    title: () => "Tools",
    role: "admin",
    load: () => loadTools(),
    nav: { label: "Tools", icon: "tools", order: 11, group: "Admin" },
  },
  {
    path: "/profile",
    view: lazy(() =>
      import("../views/profile/Profile.tsx").then((m) => m.Profile),
    ),
    title: () => "Profile",
    role: "authenticated",
    load: () => loadProfile(),
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

// the rail's rows in order: a route on its own, or a group with the
// routes it holds, placed where its first route sorts
export type RailRow =
  | { kind: "route"; route: Route }
  | { kind: "group"; name: string; icon: IconName; routes: Route[] };

export function railRows(role: "admin" | "member", routes = ROUTES) {
  const rows: RailRow[] = [];
  for (const route of navEntries(role, routes)) {
    const group = route.nav!.group;
    if (group === undefined) {
      rows.push({ kind: "route", route });
      continue;
    }
    const open = rows.find((r) => r.kind === "group" && r.name === group);
    if (open && open.kind === "group") open.routes.push(route);
    else {
      rows.push({
        kind: "group",
        name: group,
        icon: GROUP_ICONS[group] ?? "settings",
        routes: [route],
      });
    }
  }
  return rows;
}
