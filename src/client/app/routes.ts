// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one route table. Every view is one entry: the path pattern, the
// view, its title, the role it needs, what it loads, and either a rail
// entry or hidden. The rail and the tests read this; the server
// enforces access, never this table.
// A view is loaded on first use, so the table stays one small module
// however many views there are; only Login is in the first bundle,
// since App needs it before any route.

import { isDecisionId } from "../../shared/contracts/decision.ts";
import { isRunFilter, type SessionOrigin } from "../../shared/words.ts";
import { refreshAccessBoard } from "../data/access-board.ts";
import {
  loadAdminProject,
  loadAdminProjects,
  loadProjectUsage,
} from "../data/admin-projects.ts";
import { loadAgents, loadFacts } from "../data/agents.ts";
import { loadAutomationPage, loadAutomations } from "../data/automations.ts";
import { loadCredentials } from "../data/credentials.ts";
import {
  deciders,
  loadDeciders,
  loadDeciderUsage,
  loadDecisionUsage,
} from "../data/deciders.ts";
import { loadDecisions } from "../data/decisions.ts";
import {
  loadAgentDays,
  loadAgentPage,
  loadDeciderDays,
  loadDeciderPage,
  loadDirectoryAgents,
  loadDirectoryDeciders,
  loadDirectoryUsers,
  loadUserDays,
  loadUserPage,
} from "../data/directory.ts";
import { loadKnowledge } from "../data/knowledge.ts";
import { loadDocPage, onlyLineMoved } from "../data/knowledge-file.ts";
import {
  loadAllUsage,
  loadMcp,
  loadServerUsage,
  servers,
} from "../data/mcp.ts";
import { me } from "../data/me.ts";
import { keyOf, loadMemory } from "../data/memory.ts";
import { loadNotSent } from "../data/not-sent.ts";
import {
  loadAttention,
  loadOverview,
  loadStorage,
  loadUsage,
  overviewRange,
} from "../data/overview.ts";
import { loadProfile } from "../data/profile.ts";
import {
  loadProject,
  loadProjects,
  project,
  projects,
} from "../data/projects.ts";
import {
  loadProviders,
  loadProviderUsage,
  providers,
} from "../data/providers.ts";
import { loadRepos } from "../data/repos.ts";
import {
  homeProjectId,
  loadList,
  loadProjectAgents,
  loadSession,
  session,
} from "../data/sessions.ts";
import {
  loadAllSkillUsage,
  loadSkills,
  loadSkillUsage,
  skills,
} from "../data/skills.ts";
import { loadSmtp } from "../data/smtp.ts";
import { loadTools, loadVisualsUsage, loadWebUsage } from "../data/tools.ts";
import { loadUploads } from "../data/uploads.ts";
import { loadDays, loadRecentDays, loadWeek } from "../data/usage.ts";
import { loadUsers, loadUserUsage, users } from "../data/users.ts";
import type { IconName } from "../lib/icons.tsx";
import { DECISION_WORDS } from "../views/admin/Decisions.model.ts";
import {
  composeProjectOf,
  listPick,
  pickOf,
} from "../views/home/Home.model.ts";
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
  nav?: { label: string; icon: IconName; order: number };
};

// a project page's head, tabs and aside
const frame = (id: string) => [
  loadProject(id),
  loadProjectAgents(id),
  loadAutomations(id),
  loadRecentDays(),
];
const framed = async (params: Params) => {
  await Promise.all(frame(params.id));
};

// the automation's two tabs share one view, so a tab change keeps the
// page mounted instead of drawing it again
const automationView = lazy(() =>
  import("../views/projects/Automation.tsx").then((m) => m.Automation),
);

// a file's page, its history and its past revisions are one view
const docView = lazy(() =>
  import("../views/knowledge/file/DocPage.tsx").then((m) => m.DocPage),
);

type Tab = readonly [suffix: string, title: (params: Params) => string];

// a page's tabs share one view, so a draft outlives a tab switch
const tabRoutes = (
  base: string,
  tabs: readonly Tab[],
  view: Lazy<{ params: Params }>,
  role: Route["role"],
  load: NonNullable<Route["load"]>,
): Route[] =>
  tabs.map(([suffix, title]) => ({
    path: base + suffix,
    view,
    title,
    role,
    load,
  }));

// the aside's usage is read by id, which only the list gives
const thenUsage = async <T extends { id: string }>(
  lists: Promise<unknown>[],
  rows: { readonly value: T[] | null },
  shown: (row: T) => boolean,
  usage: (id: string) => Promise<void>,
) => {
  await Promise.all(lists);
  const row = rows.value?.find(shown);
  if (row !== undefined) await usage(row.id);
};

// the list feeds the name's switcher
const agentPage = async (params: Params) => {
  await Promise.all([
    loadAgentPage(params.name),
    loadAgentDays(params.name),
    loadDirectoryAgents(),
  ]);
};

const deciderPage = async (params: Params) => {
  await Promise.all([
    loadDeciderPage(params.name),
    loadDeciderDays(params.name),
  ]);
};

const userPage = async (params: Params) => {
  await Promise.all([
    loadUserPage(params.username),
    loadUserDays(params.username),
    loadDirectoryUsers(),
  ]);
};

const webAccess = async () => {
  await Promise.all([loadTools(), loadWebUsage(), loadCredentials()]);
};

// the project and the agents follow the session, since only its row
// says which project it is in; the other origin's page shows nothing
const sessionPage = async (id: string, origin: SessionOrigin) => {
  await loadSession(id);
  const detail = session.value;
  if (detail === null || detail.session.id !== id) return;
  if (detail.session.origin !== origin) return;
  const projectId = detail.session.projectId;
  // a run names its automation under the title
  await Promise.all([
    project.value?.id === projectId ? undefined : loadProject(projectId),
    loadProjectAgents(projectId),
    // a run has no composer, so nothing is staged for it
    origin === "chat" ? loadUploads(projectId) : undefined,
    detail.session.automationId === null
      ? undefined
      : loadAutomations(projectId),
  ]);
};

export const ALIASES: Record<string, string> = {
  "/admin": "/admin/monitor",
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
    // the feed for the query, the user's messages that were not sent,
    // the week for the aside, and the agents of the composer's project,
    // the picked one or the personal; it comes from the rail's list,
    // waited for only when none is held
    load: async (_params, query) => {
      const q = query.get("q")?.trim() ?? "";
      const pick = listPick(pickOf(`?${query.toString()}`));
      const rows = loadList({ project: null, q, ...pick });
      const spent = loadWeek();
      const unsent = loadNotSent();
      const listed = loadProjects();
      if (projects.value === null) await listed;
      const target = composeProjectOf(projects.value, homeProjectId.value);
      await Promise.all([
        listed,
        rows,
        spent,
        unsent,
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
  // every list loads on each tab, so each tab's count shows
  ...tabRoutes(
    "/directory",
    [
      ["", () => "Directory"],
      ["/agents", () => "Directory agents"],
      ["/deciders", () => "Directory deciders"],
    ],
    lazy(() =>
      import("../views/directory/Directory.tsx").then((m) => m.Directory),
    ),
    "authenticated",
    async () => {
      await Promise.all([
        loadDirectoryUsers(),
        loadDirectoryAgents(),
        loadDirectoryDeciders(),
      ]);
    },
  ).map(
    (route, i): Route =>
      i === 0
        ? { ...route, nav: { label: "Directory", icon: "users", order: 3 } }
        : route,
  ),
  {
    path: "/projects/:id",
    view: lazy(() =>
      import("../views/projects/Project.tsx").then((m) => m.Project),
    ),
    title: () => "Project",
    role: "authenticated",
    load: async (params, query) => {
      await Promise.all([
        ...frame(params.id),
        loadList({
          project: params.id,
          q: query.get("q")?.trim() ?? "",
          ...listPick(pickOf(`?${query.toString()}`)),
        }),
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
    load: framed,
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
        ...frame(params.id),
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
      await Promise.all([...frame(params.id), loadKnowledge(params.id)]);
    },
  },
  {
    // ?line= lights a line, ?revision= opens a past one, ?history lists
    // them
    path: "/projects/:id/knowledge/files/:fileId",
    view: docView,
    title: () => "Knowledge",
    role: "authenticated",
    // the agents answer says whether visuals are on, for an HTML file
    load: async (params, query) => {
      // a click on a line number reads nothing again
      if (onlyLineMoved(params.id, params.fileId, query)) return;
      await Promise.all([
        loadProject(params.id),
        loadProjectAgents(params.id),
        loadDocPage(params.id, params.fileId, query),
      ]);
    },
  },
  {
    // ?folder= is where the path starts
    path: "/projects/:id/knowledge/new",
    view: lazy(() =>
      import("../views/knowledge/file/DocPage.tsx").then((m) => m.NewDoc),
    ),
    title: () => "New file",
    role: "authenticated",
    load: async (params) => {
      await Promise.all([loadProject(params.id), loadKnowledge(params.id)]);
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
    load: framed,
  },
  {
    path: "/projects/:id/settings",
    view: lazy(() =>
      import("../views/projects/Settings.tsx").then((m) => m.Settings),
    ),
    title: () => "Settings",
    role: "authenticated",
    load: async (params) => {
      // an admin picks a team project's key files there
      const keys =
        me.value?.role === "admin" &&
        projects.value?.find((p) => p.id === params.id)?.kind !== "personal";
      await Promise.all([
        ...frame(params.id),
        loadRepos(params.id),
        ...(keys ? [loadCredentials()] : []),
      ]);
    },
  },
  {
    path: "/chat/:id",
    view: lazy(() => import("../views/sessions/Chat.tsx").then((m) => m.Chat)),
    title: () => "Chat",
    role: "authenticated",
    load: (params) => sessionPage(params.id, "chat"),
  },
  {
    path: "/run/:id",
    view: lazy(() => import("../views/sessions/Chat.tsx").then((m) => m.Run)),
    title: () => "Run",
    role: "authenticated",
    load: (params) => sessionPage(params.id, "automation"),
  },
  {
    path: "/admin/monitor",
    view: lazy(() =>
      import("../views/admin/Overview.tsx").then((m) => m.Overview),
    ),
    title: () => "Monitor",
    role: "admin",
    load: async () => {
      await Promise.all([loadOverview(overviewRange.value), loadAttention()]);
    },
  },
  {
    path: "/admin/monitor/usage",
    view: lazy(() => import("../views/admin/Usage.tsx").then((m) => m.Usage)),
    title: () => "Usage",
    role: "admin",
    load: (_params, q) => loadUsage(q.get("month")),
  },
  {
    path: "/admin/monitor/storage",
    view: lazy(() =>
      import("../views/admin/Storage.tsx").then((m) => m.Storage),
    ),
    title: () => "Storage",
    role: "admin",
    load: () => loadStorage(),
  },
  {
    path: "/admin/access",
    view: lazy(() =>
      import("../views/admin/AccessBoard.tsx").then((m) => m.AccessBoard),
    ),
    title: () => "Access",
    role: "admin",
    load: () => refreshAccessBoard(),
  },
  {
    path: "/admin/access/users",
    view: lazy(() => import("../views/admin/Users.tsx").then((m) => m.Users)),
    title: () => "Users",
    role: "admin",
    load: () => loadUsers(),
  },
  {
    path: "/admin/access/users/:username",
    view: lazy(() =>
      import("../views/admin/UserPage.tsx").then((m) => m.UserPage),
    ),
    title: (params) => `@${params.username}`,
    role: "admin",
    load: (params) =>
      thenUsage(
        [loadUsers(), loadProjects()],
        users,
        (u) => u.username === params.username,
        loadUserUsage,
      ),
  },
  {
    path: "/admin/access/projects",
    view: lazy(() =>
      import("../views/admin/AdminProjects.tsx").then((m) => m.AdminProjects),
    ),
    title: () => "Projects",
    role: "admin",
    load: async () => {
      await Promise.all([loadAdminProjects(), loadUsers()]);
    },
  },
  {
    path: "/admin/access/projects/:id",
    view: lazy(() =>
      import("../views/admin/ProjectPage.tsx").then((m) => m.ProjectPage),
    ),
    title: () => "Project",
    role: "admin",
    load: async (params) => {
      await Promise.all([
        loadAdminProjects(),
        loadUsers(),
        loadAdminProject(params.id),
        loadProjectUsage(params.id),
        loadRepos(params.id),
        loadCredentials(),
      ]);
    },
  },
  ...tabRoutes(
    "/admin/config",
    [
      ["", () => "Config"],
      ["/limits", () => "Limits"],
      ["/storage", () => "Storage"],
    ],
    lazy(() =>
      import("../views/admin/ConfigBoard.tsx").then((m) => m.ConfigBoard),
    ),
    "admin",
    async () => {
      await Promise.all([
        loadTools(),
        loadProviders(),
        loadAgents(),
        loadDeciders(),
        loadMcp(),
        loadSkills(),
        loadCredentials(),
      ]);
    },
  ),
  {
    path: "/admin/config/providers",
    view: lazy(() =>
      import("../views/admin/Providers.tsx").then((m) => m.Providers),
    ),
    title: () => "Providers",
    role: "admin",
    load: async () => {
      await Promise.all([loadAgents(), loadProviders(), loadOverview()]);
    },
  },
  {
    path: "/admin/config/providers/:name",
    view: lazy(() =>
      import("../views/admin/ProviderPage.tsx").then((m) => m.ProviderPage),
    ),
    title: (params) => params.name,
    role: "admin",
    load: (params) =>
      thenUsage(
        [loadProviders(), loadAgents(), loadDeciders()],
        providers,
        (p) => p.name === params.name,
        loadProviderUsage,
      ),
  },
  {
    path: "/admin/config/agents",
    view: lazy(() =>
      import("../views/admin/AgentList.tsx").then((m) => m.AgentList),
    ),
    title: () => "Agents",
    role: "admin",
    // New agent is the list's `?new`, since /admin/config/agents/new
    // would be an agent's page
    load: async () => {
      await Promise.all([
        loadAgents(),
        loadProviders(),
        loadSkills(),
        loadMcp(),
        loadOverview(),
      ]);
    },
  },
  ...tabRoutes(
    "/admin/config/agents/:name",
    [
      ["", (params) => `@${params.name}`],
      ["/skills", (params) => `@${params.name}`],
      ["/mcp", (params) => `@${params.name}`],
    ],
    lazy(() => import("../views/admin/AgentPage.tsx").then((m) => m.AgentPage)),
    "admin",
    async (params) => {
      await Promise.all([
        loadAgents(),
        loadProviders(),
        loadSkills(),
        loadMcp(),
      ]);
      await loadFacts(params.name);
    },
  ),
  {
    path: "/admin/config/deciders",
    view: lazy(() =>
      import("../views/admin/DeciderLists.tsx").then((m) => m.DeciderList),
    ),
    title: () => "Deciders",
    role: "admin",
    load: async () => {
      await Promise.all([
        loadDeciders(),
        loadDecisions(),
        loadProviders(),
        loadOverview(),
      ]);
    },
  },
  {
    path: "/admin/config/deciders/:name",
    view: lazy(() =>
      import("../views/admin/DeciderPage.tsx").then((m) => m.DeciderPage),
    ),
    title: (params) => params.name,
    role: "admin",
    load: (params) =>
      thenUsage(
        [loadDeciders(), loadDecisions(), loadProviders()],
        deciders,
        (d) => d.name === params.name,
        loadDeciderUsage,
      ),
  },
  {
    path: "/admin/config/decisions",
    view: lazy(() =>
      import("../views/admin/DeciderLists.tsx").then((m) => m.DecisionList),
    ),
    title: () => "Decisions",
    role: "admin",
    load: async () => {
      await Promise.all([loadDeciders(), loadDecisions(), loadOverview()]);
    },
  },
  {
    path: "/admin/config/decisions/:id",
    view: lazy(() =>
      import("../views/admin/DecisionPage.tsx").then((m) => m.DecisionPage),
    ),
    title: (params) =>
      isDecisionId(params.id) ? DECISION_WORDS[params.id].title : "Decision",
    role: "admin",
    load: async (params) => {
      await Promise.all([
        loadDeciders(),
        loadDecisions(),
        loadDecisionUsage(params.id),
      ]);
    },
  },
  ...tabRoutes(
    "/admin/config/web",
    [
      ["", () => "Web access"],
      ["/credentials", () => "Credentials"],
    ],
    lazy(() => import("../views/admin/WebAccess.tsx").then((m) => m.WebAccess)),
    "admin",
    webAccess,
  ),
  {
    path: "/admin/config/web/credentials/:name",
    view: lazy<{ params: Params }>(() =>
      import("../views/admin/CredentialPage.tsx").then((m) => m.CredentialPage),
    ),
    title: (params) => params.name,
    role: "admin",
    load: async () => {
      await Promise.all([loadTools(), loadCredentials()]);
    },
  },
  {
    path: "/admin/config/smtp",
    view: lazy(() => import("../views/admin/Smtp.tsx").then((m) => m.Smtp)),
    title: () => "SMTP",
    role: "admin",
    load: loadSmtp,
  },
  {
    path: "/admin/config/visuals",
    view: lazy(() =>
      import("../views/admin/Visuals.tsx").then((m) => m.Visuals),
    ),
    title: () => "Visuals",
    role: "admin",
    load: async () => {
      await Promise.all([loadTools(), loadVisualsUsage()]);
    },
  },
  {
    path: "/admin/config/skills",
    view: lazy(() =>
      import("../views/admin/SkillList.tsx").then((m) => m.SkillList),
    ),
    title: () => "Skills",
    role: "admin",
    load: async () => {
      await Promise.all([loadSkills(), loadAgents(), loadAllSkillUsage()]);
    },
  },
  ...tabRoutes(
    "/admin/config/skills/:name",
    [
      ["", (params) => params.name],
      ["/files", (params) => `${params.name} files`],
    ],
    lazy(() => import("../views/admin/SkillPage.tsx").then((m) => m.SkillPage)),
    "admin",
    (params) =>
      thenUsage(
        [loadSkills(), loadAgents()],
        skills,
        (s) => s.name === params.name,
        loadSkillUsage,
      ),
  ),
  {
    path: "/admin/config/mcp",
    view: lazy(() =>
      import("../views/admin/McpList.tsx").then((m) => m.McpList),
    ),
    title: () => "MCP Servers",
    role: "admin",
    load: async () => {
      await Promise.all([loadMcp(), loadAgents(), loadAllUsage()]);
    },
  },
  ...tabRoutes(
    "/admin/config/mcp/:name",
    [
      ["", (params) => params.name],
      ["/tools", (params) => `${params.name} tools`],
    ],
    lazy(() => import("../views/admin/McpPage.tsx").then((m) => m.McpPage)),
    "admin",
    (params) =>
      thenUsage(
        [loadMcp(), loadAgents()],
        servers,
        (s) => s.name === params.name,
        loadServerUsage,
      ),
  ),
  ...tabRoutes(
    "/users/:username",
    [
      ["", (params) => `@${params.username}`],
      ["/projects", (params) => `@${params.username} projects`],
    ],
    lazy(() => import("../views/directory/User.tsx").then((m) => m.User)),
    "authenticated",
    userPage,
  ),
  // the page and its days load apart, so the page draws before the days
  ...tabRoutes(
    "/agents/:name",
    [
      ["", (params) => `@${params.name}`],
      ["/tools", (params) => `@${params.name} tools`],
      ["/skills", (params) => `@${params.name} skills`],
      ["/mcp", (params) => `@${params.name} MCP`],
    ],
    lazy(() => import("../views/directory/Agent.tsx").then((m) => m.Agent)),
    "authenticated",
    agentPage,
  ),
  {
    path: "/deciders/:name",
    view: lazy(() =>
      import("../views/directory/Decider.tsx").then((m) => m.Decider),
    ),
    title: (params) => params.name,
    role: "authenticated",
    load: deciderPage,
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

type Match = { route: Route; params: Params };

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

export function navEntries(routes = ROUTES) {
  return routes
    .filter((r) => r.nav !== undefined)
    .sort((a, b) => a.nav!.order - b.nav!.order);
}
