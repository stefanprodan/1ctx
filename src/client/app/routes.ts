// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one route table. Every view is one entry: the path pattern, the
// view, its title, the role it needs, what it loads, and either a rail
// entry or hidden. The admin pages are the zones' in app/zones.ts. The
// rail and the tests read this; the server enforces access, never this
// table.
// A view is loaded on first use, so the table stays one small module
// however many views there are; only Login is in the first bundle,
// since App needs it before any route.

import { isDecisionId } from "../../shared/contracts/decision.ts";
import { isRunFilter } from "../../shared/words.ts";
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
  loadPerson,
  loadPersonDays,
} from "../data/directory.ts";
import { loadKnowledge } from "../data/knowledge.ts";
import { loadDocPage, onlyLineMoved } from "../data/knowledge-file.ts";
import {
  loadAllUsage,
  loadMcp,
  loadServerUsage,
  servers,
} from "../data/mcp.ts";
import { keyOf, loadMemory } from "../data/memory.ts";
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
import { loadTools, loadVisualsUsage, loadWebUsage } from "../data/tools.ts";
import { loadUploads } from "../data/uploads.ts";
import { loadDays, loadRecentDays, loadWeek } from "../data/usage.ts";
import { loadUsers, loadUserUsage, users } from "../data/users.ts";
import type { IconName } from "../lib/icons.tsx";
import { DECISION_WORDS } from "../views/admin/Decisions.model.ts";
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
  // the working face's rail rows; the admin face's are app/zones.ts
  nav?: { label: string; icon: IconName; order: number };
};

// a project page's head, tabs and aside
const frame = (id: string) => [
  loadProject(id),
  loadProjectAgents(id),
  loadAutomations(id),
  loadRecentDays(),
];

// the automation's two tabs share one view, so a tab change keeps the
// page mounted instead of drawing it again
const automationView = lazy(() =>
  import("../views/projects/Automation.tsx").then((m) => m.Automation),
);

// a file's page, its history and its past revisions are one view
const docView = lazy(() =>
  import("../views/knowledge/file/DocPage.tsx").then((m) => m.DocPage),
);

// an agent's tabs share one view the same way, its heatmap included;
// the page and its days load apart, so the page draws before the days
const agentView = lazy<{ params: Params }>(() =>
  import("../views/people/Agent.tsx").then((m) => m.Agent),
);
const agentPage = async (name: string) => {
  await Promise.all([loadAgentPage(name), loadAgentDays(name)]);
};

// the Config agent page's tabs share one view, so a draft outlives a
// tab switch; the page's facts need the list, which names the agent
const configAgentView = lazy<{ params: Params }>(() =>
  import("../views/admin/AgentPage.tsx").then((m) => m.AgentPage),
);
const configAgentPage = async (name: string) => {
  await Promise.all([loadAgents(), loadProviders(), loadSkills(), loadMcp()]);
  await loadFacts(name);
};
const configAgentRoutes = (["", "/skills", "/mcp"] as const).map(
  (tab): Route => ({
    path: `/admin/config/agents/:name${tab}`,
    view: configAgentView,
    title: (params) => `@${params.name}`,
    role: "admin",
    load: (params) => configAgentPage(params.name),
  }),
);

// an MCP server's tabs share one view the same way; Used by and Delete
// name the agents, and the aside's usage needs the server's id, which
// the list gives
const configMcpView = lazy<{ params: Params }>(() =>
  import("../views/admin/McpPage.tsx").then((m) => m.McpPage),
);
// a skill's tabs share one view as well; Used by names the agents, and
// the aside's usage needs the skill's id, which the list gives
const configSkillView = lazy<{ params: Params }>(() =>
  import("../views/admin/SkillPage.tsx").then((m) => m.SkillPage),
);
const configSkillRoutes = (["", "/files"] as const).map(
  (tab): Route => ({
    path: `/admin/config/skills/:name${tab}`,
    view: configSkillView,
    title: (params) => (tab === "" ? params.name : `${params.name} files`),
    role: "admin",
    load: async (params) => {
      await Promise.all([loadSkills(), loadAgents()]);
      const shown = skills.value?.find((s) => s.name === params.name);
      if (shown !== undefined) await loadSkillUsage(shown.id);
    },
  }),
);

const configMcpRoutes = (["", "/tools"] as const).map(
  (tab): Route => ({
    path: `/admin/config/mcp/:name${tab}`,
    view: configMcpView,
    title: (params) => (tab === "" ? params.name : `${params.name} tools`),
    role: "admin",
    load: async (params) => {
      await Promise.all([loadMcp(), loadAgents()]);
      const shown = servers.value?.find((s) => s.name === params.name);
      if (shown !== undefined) await loadServerUsage(shown.id);
    },
  }),
);

// a user's tabs share one view the same way
const userView = lazy<{ params: Params }>(() =>
  import("../views/people/User.tsx").then((m) => m.User),
);
const userPage = async (username: string) => {
  await Promise.all([loadPerson(username), loadPersonDays(username)]);
};

// Config's board's three tabs share one view the same way
const configBoardView = lazy<{ params: Params }>(() =>
  import("../views/admin/ConfigBoard.tsx").then((m) => m.ConfigBoard),
);
const configBoardRoutes = (
  [
    ["", "Config"],
    ["/limits", "Limits"],
    ["/storage", "Storage"],
  ] as const
).map(
  ([tab, title]): Route => ({
    path: `/admin/config${tab}`,
    view: configBoardView,
    title: () => title,
    role: "admin",
    // the aside counts what the other Config pages list
    load: async () => {
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
  }),
);

// and Web access's two
const webAccessView = lazy<{ params: Params }>(() =>
  import("../views/admin/WebAccess.tsx").then((m) => m.WebAccess),
);

// addresses with no page of their own that open another in place
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
        ...frame(params.id),
        loadList({
          project: params.id,
          q: query.get("q")?.trim() ?? "",
          origin: originOf(`?${query.toString()}`),
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
    load: async (params) => {
      await Promise.all(frame(params.id));
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
    load: async (params) => {
      await Promise.all(frame(params.id));
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
      await Promise.all(frame(params.id));
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
    // New user is the list's `?new`
    load: () => loadUsers(),
  },
  {
    path: "/admin/access/users/:username",
    view: lazy(() =>
      import("../views/admin/UserPage.tsx").then((m) => m.UserPage),
    ),
    title: (params) => `@${params.username}`,
    role: "admin",
    // the Projects card names the team projects; the aside's usage needs
    // the user's id, which the list gives
    load: async (params) => {
      await Promise.all([loadUsers(), loadProjects()]);
      const shown = users.value?.find((u) => u.username === params.username);
      if (shown !== undefined) await loadUserUsage(shown.id);
    },
  },
  {
    path: "/admin/access/projects",
    view: lazy(() =>
      import("../views/admin/AdminProjects.tsx").then((m) => m.AdminProjects),
    ),
    title: () => "Projects",
    role: "admin",
    // New project is the list's `?new`; the aside counts the personal
    // projects by the users
    load: async () => {
      await Promise.all([loadAdminProjects(), loadUsers()]);
    },
  },
  {
    path: "/admin/access/projects/:id",
    view: lazy(() =>
      import("../views/admin/ProjectPage.tsx").then((m) => m.ProjectPage),
    ),
    // by id, as the project's own page
    title: () => "Project",
    role: "admin",
    // Add member offers the users
    load: async (params) => {
      const id = params.id ?? "";
      await Promise.all([
        loadAdminProjects(),
        loadUsers(),
        loadAdminProject(id),
        loadProjectUsage(id),
      ]);
    },
  },
  ...configBoardRoutes,
  {
    path: "/admin/config/providers",
    view: lazy(() =>
      import("../views/admin/Providers.tsx").then((m) => m.Providers),
    ),
    title: () => "Providers",
    role: "admin",
    // New provider is the list's `?new`, as New agent is
    load: async () => {
      // a provider row counts the agents on it, and the aside reads the
      // instance's last 30 days
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
    // the rows under Used by name the agents and the deciders on it;
    // the aside's usage needs the provider's id, which the list gives
    load: async (params) => {
      await Promise.all([loadProviders(), loadAgents(), loadDeciders()]);
      const shown = providers.value?.find((p) => p.name === params.name);
      if (shown !== undefined) await loadProviderUsage(shown.id);
    },
  },
  {
    path: "/admin/config/agents",
    view: lazy(() =>
      import("../views/admin/AgentList.tsx").then((m) => m.AgentList),
    ),
    title: (_params) => "Agents",
    role: "admin",
    // New agent is the list's `?new`, since /admin/config/agents/new would be
    // an agent's page; the rows' failing lines read the skills and servers
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
  ...configAgentRoutes,
  {
    path: "/admin/config/deciders",
    view: lazy(() =>
      import("../views/admin/DeciderLists.tsx").then((m) => m.DeciderList),
    ),
    title: () => "Deciders",
    role: "admin",
    // New decider is the list's `?new`; the tabs count the decisions and
    // the aside reads the instance's last 30 days
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
    // the model's provider and the decisions that ask it; the aside's
    // usage needs the decider's id, which the list gives
    load: async (params) => {
      await Promise.all([loadDeciders(), loadDecisions(), loadProviders()]);
      const shown = deciders.value?.find((d) => d.name === params.name);
      if (shown !== undefined) await loadDeciderUsage(shown.id);
    },
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
    // the tab says which decision; an unknown id is the page's own word
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
  {
    path: "/admin/config/web",
    view: webAccessView,
    title: () => "Web access",
    role: "admin",
    load: async () => {
      await Promise.all([loadTools(), loadWebUsage(), loadCredentials()]);
    },
  },
  {
    path: "/admin/config/web/credentials",
    view: webAccessView,
    title: () => "Credentials",
    role: "admin",
    load: async () => {
      await Promise.all([loadTools(), loadWebUsage(), loadCredentials()]);
    },
  },
  {
    path: "/admin/config/web/credentials/:name",
    view: lazy<{ params: Params }>(() =>
      import("../views/admin/CredentialPage.tsx").then((m) => m.CredentialPage),
    ),
    title: (params) => params.name,
    role: "admin",
    // the tools say whether web access is off, which the page says too
    load: async () => {
      await Promise.all([loadTools(), loadCredentials()]);
    },
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
    // Add skill is the list's `?new`; a row counts the agents that carry
    // it and the aside reads every skill's last 30 days
    load: async () => {
      await Promise.all([loadSkills(), loadAgents(), loadAllSkillUsage()]);
    },
  },
  ...configSkillRoutes,
  {
    path: "/admin/config/mcp",
    view: lazy(() =>
      import("../views/admin/McpList.tsx").then((m) => m.McpList),
    ),
    title: () => "MCP Servers",
    role: "admin",
    // New server is the list's `?new`; a row counts the agents on it and
    // the aside reads every server's last 30 days
    load: async () => {
      await Promise.all([loadMcp(), loadAgents(), loadAllUsage()]);
    },
  },
  ...configMcpRoutes,
  {
    path: "/users/:username",
    view: userView,
    title: (params) => `@${params.username}`,
    role: "authenticated",
    load: (params) => userPage(params.username),
  },
  {
    path: "/users/:username/projects",
    view: userView,
    title: (params) => `@${params.username} projects`,
    role: "authenticated",
    load: (params) => userPage(params.username),
  },
  {
    path: "/agents/:name",
    view: agentView,
    title: (params) => `@${params.name}`,
    role: "authenticated",
    load: (params) => agentPage(params.name),
  },
  {
    path: "/agents/:name/tools",
    view: agentView,
    title: (params) => `@${params.name} tools`,
    role: "authenticated",
    load: (params) => agentPage(params.name),
  },
  {
    path: "/agents/:name/skills",
    view: agentView,
    title: (params) => `@${params.name} skills`,
    role: "authenticated",
    load: (params) => agentPage(params.name),
  },
  {
    path: "/agents/:name/mcp",
    view: agentView,
    title: (params) => `@${params.name} MCP`,
    role: "authenticated",
    load: (params) => agentPage(params.name),
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

// the working face's rail rows, in order
export function navEntries(routes = ROUTES) {
  return routes
    .filter((r) => r.nav !== undefined)
    .sort((a, b) => a.nav!.order - b.nav!.order);
}
