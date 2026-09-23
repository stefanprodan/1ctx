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

import { isRunFilter } from "../../shared/words.ts";
import { loadAdminProject, loadAdminProjects } from "../data/admin-projects.ts";
import { loadAgents } from "../data/agents.ts";
import { loadAutomationPage, loadAutomations } from "../data/automations.ts";
import { loadAgentPage, loadPerson } from "../data/directory.ts";
import { loadKnowledge } from "../data/knowledge.ts";
import { loadMcp } from "../data/mcp.ts";
import { keyOf, loadMemory } from "../data/memory.ts";
import { loadStorage } from "../data/overview.ts";
import { loadProfile } from "../data/profile.ts";
import {
  loadProject,
  loadProjects,
  project,
  projects,
} from "../data/projects.ts";
import { loadProviders } from "../data/providers.ts";
import {
  homeProjectId,
  loadList,
  loadProjectAgents,
  loadSession,
  session,
} from "../data/sessions.ts";
import { loadSkills } from "../data/skills.ts";
import { loadTools } from "../data/tools.ts";
import { loadUploads } from "../data/uploads.ts";
import { loadDays, loadRecentDays, loadWeek } from "../data/usage.ts";
import { loadUsers } from "../data/users.ts";
import type { IconName } from "../lib/icons.tsx";
import { composeProjectOf, originOf } from "../views/home/Home.model.ts";
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

// the automation's two tabs share one view, so a tab change keeps the
// page mounted instead of drawing it again
const automationView = lazy(() =>
  import("../views/projects/Automation.tsx").then((m) => m.Automation),
);

// the tools page's three tabs share one view the same way
const toolsView = lazy<{ params: Params }>(() =>
  import("../views/admin/Tools.tsx").then((m) => m.Tools),
);

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
    // the stream for the query, the week for the aside, and the agents of
    // the composer's project, the picked one or the personal; it comes
    // from the rail's list, waited for only when none is held
    load: async (_params, query) => {
      const q = query.get("q")?.trim() ?? "";
      const origin = originOf(`?${query.toString()}`);
      const rows = loadList({ project: null, q, origin });
      const spent = loadWeek();
      const listed = loadProjects();
      if (projects.value === null) await listed;
      const target = composeProjectOf(projects.value, homeProjectId.value);
      await Promise.all([
        listed,
        rows,
        spent,
        target === null ? Promise.resolve() : loadProjectAgents(target.id),
        // the files staged for the composer's draft, and the limits a
        // pick is judged with
        target === null ? Promise.resolve() : loadUploads(target.id),
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
    // the list, and for the aside the week and the agents, which every
    // project offers alike, read through the personal one
    load: async () => {
      const spent = loadWeek();
      const activity = loadDays();
      const listed = loadProjects();
      if (projects.value === null) await listed;
      const personal = composeProjectOf(projects.value, null);
      await Promise.all([
        listed,
        spent,
        activity,
        personal === null ? Promise.resolve() : loadProjectAgents(personal.id),
      ]);
    },
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
        loadList({
          project: params.id,
          q: query.get("q")?.trim() ?? "",
          origin: originOf(`?${query.toString()}`),
        }),
        loadProjectAgents(params.id),
        loadAutomations(params.id),
        loadRecentDays(),
        loadUploads(params.id),
      ]);
    },
  },
  {
    path: "/projects/:id/automations",
    view: lazy(() =>
      import("../views/projects/Automations.tsx").then((m) => m.Automations),
    ),
    title: () => "Automations",
    role: "authenticated",
    load: async (params) => {
      await Promise.all([
        loadProject(params.id),
        loadProjectAgents(params.id),
        loadAutomations(params.id),
        loadRecentDays(),
      ]);
    },
  },
  {
    path: "/projects/:id/memory",
    view: lazy(() =>
      import("../views/projects/Memory.tsx").then((m) => m.Memory),
    ),
    title: () => "Memory",
    role: "authenticated",
    load: async (params) => {
      await Promise.all([
        loadProject(params.id),
        loadProjectAgents(params.id),
        loadAutomations(params.id),
        loadRecentDays(),
        loadMemory(keyOf(params.id, null)),
      ]);
    },
  },
  {
    path: "/projects/:id/knowledge",
    view: lazy(() =>
      import("../views/knowledge/Knowledge.tsx").then((m) => m.Knowledge),
    ),
    title: () => "Knowledge",
    role: "authenticated",
    load: async (params) => {
      await Promise.all([
        loadProject(params.id),
        loadProjectAgents(params.id),
        loadAutomations(params.id),
        loadRecentDays(),
        loadKnowledge(params.id),
      ]);
    },
  },
  {
    path: "/projects/:id/automations/new",
    view: lazy(() =>
      import("../views/projects/AutomationEditor.tsx").then(
        (m) => m.NewAutomation,
      ),
    ),
    title: () => "New scheduled task",
    role: "authenticated",
    // the list for the deadline limit and the tab's count
    load: async (params) => {
      await Promise.all([
        loadProject(params.id),
        loadProjectAgents(params.id),
        loadAutomations(params.id),
      ]);
    },
  },
  {
    path: "/automations/:id",
    view: automationView,
    title: () => "Automation",
    role: "authenticated",
    // ?runs=failed|manual narrows the runs
    load: (params, query) => {
      const filter = query.get("runs");
      return loadAutomationPage(params.id, isRunFilter(filter) ? filter : null);
    },
  },
  {
    path: "/automations/:id/memory",
    view: automationView,
    title: () => "Memory",
    role: "authenticated",
    // the runs still load, for the tally in the aside
    load: (params) => loadAutomationPage(params.id, null),
  },
  {
    path: "/automations/:id/edit",
    view: lazy(() =>
      import("../views/projects/AutomationEditor.tsx").then(
        (m) => m.EditAutomation,
      ),
    ),
    title: () => "Edit automation",
    role: "authenticated",
    load: (params) => loadAutomationPage(params.id, undefined),
  },
  {
    path: "/projects/:id/members",
    view: lazy(() =>
      import("../views/projects/Members.tsx").then((m) => m.Members),
    ),
    title: () => "Members",
    role: "authenticated",
    load: async (params) => {
      await Promise.all([
        loadProject(params.id),
        loadProjectAgents(params.id),
        loadAutomations(params.id),
        loadRecentDays(),
      ]);
    },
  },
  {
    path: "/projects/:id/settings",
    view: lazy(() =>
      import("../views/projects/Settings.tsx").then((m) => m.Settings),
    ),
    title: () => "Settings",
    role: "authenticated",
    load: async (params) => {
      await Promise.all([
        loadProject(params.id),
        loadProjectAgents(params.id),
        loadAutomations(params.id),
        loadRecentDays(),
      ]);
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
      // a run names its automation under the title
      await Promise.all([
        project.value?.id === projectId ? undefined : loadProject(projectId),
        loadProjectAgents(projectId),
        // a run has no composer, so nothing is staged for it
        detail.session.origin === "chat" ? loadUploads(projectId) : undefined,
        detail.session.automationId === null
          ? undefined
          : loadAutomations(projectId),
      ]);
    },
  },
  {
    path: "/admin/storage",
    view: lazy(() =>
      import("../views/admin/Storage.tsx").then((m) => m.Storage),
    ),
    title: () => "Storage",
    role: "admin",
    load: () => loadStorage(),
    nav: { label: "Storage", icon: "storage", order: 7, group: "Admin" },
  },
  {
    path: "/admin/projects",
    view: lazy(() =>
      import("../views/admin/AdminProjects.tsx").then((m) => m.AdminProjects),
    ),
    title: () => "Projects",
    role: "admin",
    // ?open=<id> is the project page's Manage: its row opens loaded
    load: async (_params, query) => {
      const open = query.get("open");
      await Promise.all([
        loadAdminProjects(),
        loadUsers(),
        open === null ? undefined : loadAdminProject(open),
      ]);
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
      // the limits too: the agents page shows where each model compacts;
      // the skills for the form's section
      await Promise.all([
        loadAgents(),
        loadProviders(),
        loadTools(),
        loadSkills(),
        loadMcp(),
      ]);
    },
    nav: { label: "Agents", icon: "agents", order: 10, group: "Admin" },
  },
  {
    path: "/admin/tools",
    view: toolsView,
    title: () => "Tools",
    role: "admin",
    load: () => loadTools(),
    nav: { label: "Tools", icon: "tools", order: 11, group: "Admin" },
  },
  {
    path: "/admin/tools/web",
    view: toolsView,
    title: () => "Web tools",
    role: "admin",
    load: () => loadTools(),
  },
  {
    path: "/admin/tools/limits",
    view: toolsView,
    title: () => "Limits",
    role: "admin",
    load: () => loadTools(),
  },
  {
    path: "/admin/skills",
    view: lazy(() => import("../views/admin/Skills.tsx").then((m) => m.Skills)),
    title: () => "Skills",
    role: "admin",
    load: () => loadSkills(),
    nav: { label: "Skills", icon: "skill", order: 12, group: "Admin" },
  },
  {
    path: "/admin/mcp",
    view: lazy(() => import("../views/admin/Mcp.tsx").then((m) => m.Mcp)),
    title: () => "MCP",
    role: "admin",
    load: () => loadMcp(),
    nav: { label: "MCP", icon: "mcp", order: 13, group: "Admin" },
  },
  {
    path: "/users/:username",
    view: lazy(() => import("../views/people/User.tsx").then((m) => m.User)),
    title: (params) => `@${params.username}`,
    role: "authenticated",
    load: (params) => loadPerson(params.username),
  },
  {
    path: "/agents/:name",
    view: lazy(() => import("../views/people/Agent.tsx").then((m) => m.Agent)),
    title: (params) => `@${params.name}`,
    role: "authenticated",
    load: (params) => loadAgentPage(params.name),
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
