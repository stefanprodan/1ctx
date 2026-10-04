// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who and what the instance holds, read through the API as an admin:
// the team projects, the live agents, the admins and the members with
// their teams. And the fence read back: a run refuses an instance with
// a provider or an MCP server anywhere but the fakes.

import type { AgentsResponse } from "../../../src/shared/api/agents.ts";
import type { McpResponse } from "../../../src/shared/api/mcp.ts";
import type { ProjectsResponse } from "../../../src/shared/api/projects.ts";
import type { ProvidersResponse } from "../../../src/shared/api/providers.ts";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import type { UsersResponse } from "../../../src/shared/api/users.ts";
import type { Api, Who } from "./api.ts";
import { info, now, pool, stats } from "./log.ts";

export type Team = { id: string; name: string; members: string[] };

export type Directory = {
  teams: Team[];
  teamById: Map<string, Team>;
  agents: { id: string; name: string }[];
  admins: string[];
  members: string[];
  memberTeams: Map<string, string[]>;
  usernames: string[];
  userById: Map<string, string>;
};

export async function loadDirectory(api: Api, admin: Who): Promise<Directory> {
  const projects = await api.must<ProjectsResponse>(
    admin,
    "GET",
    "/api/projects",
  );
  const teams = projects.projects
    .filter((p) => p.kind === "team")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, name: p.name, members: [] as string[] }));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const agents = await api.must<AgentsResponse>(admin, "GET", "/api/agents");
  const users = await api.must<UsersResponse>(admin, "GET", "/api/users");
  const live = users.users.filter((u) => !u.disabled);
  const memberTeams = new Map<string, string[]>();
  for (const u of live) {
    if (u.role !== "member") continue;
    const mine = u.projectIds.filter((id) => teamById.has(id));
    if (mine.length === 0) continue;
    memberTeams.set(u.username, mine);
    for (const id of mine) teamById.get(id)!.members.push(u.username);
  }
  const d: Directory = {
    teams,
    teamById,
    agents: agents.agents
      .map((a) => ({ id: a.id, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    admins: live
      .filter((u) => u.role === "admin" && u.username !== admin.user)
      .map((u) => u.username)
      .sort(),
    members: [...memberTeams.keys()].sort(),
    memberTeams,
    usernames: users.users.map((u) => u.username).sort(),
    userById: new Map(users.users.map((u) => [u.id, u.username])),
  };
  if (d.teams.length === 0 || d.agents.length === 0 || d.members.length === 0) {
    throw new Error("no team projects, agents or members: provision first");
  }
  info("directory", {
    teams: d.teams.length,
    agents: d.agents.length,
    admins: d.admins.length,
    members: d.members.length,
  });
  return d;
}

export async function signInAll(
  api: Api,
  d: Directory,
  names: string[],
): Promise<Map<string, Who>> {
  const t = now();
  const map = new Map<string, Who>();
  const index = new Map(d.usernames.map((u, i) => [u, i]));
  await pool(names, 4, async (u) => {
    map.set(u, await api.signIn(u, (index.get(u) ?? 0) + 1));
  });
  info("signed in", {
    users: map.size,
    ms: now() - t,
    login: stats(api.loginMs),
  });
  return map;
}

// the calls the fence makes, so a test can answer them in process
export type Caller = Pick<Api, "call" | "must">;

// web access off, which gates webfetch and websearch, and no search
// provider: a turn never leaves the fakes, on either target
export async function fenceWeb(api: Caller, admin: Who) {
  await api.must(admin, "PATCH", "/api/tools/web", { mode: "off" });
  await api.must(admin, "PATCH", "/api/tools/websearch", { provider: null });
}

// every provider on the fake model, every MCP server on the fake MCP,
// web access off and no search provider, read back before any load
export async function assertFenced(
  api: Caller,
  admin: Who,
  modelUrl: string,
  mcpBase: string,
) {
  const providers = await api.must<ProvidersResponse>(
    admin,
    "GET",
    "/api/providers",
  );
  const mcp = await api.must<McpResponse>(admin, "GET", "/api/mcp");
  const tools = await api.must<ToolsResponse>(admin, "GET", "/api/tools");
  const wrong = [
    ...providers.providers
      .filter((p) => p.baseUrl !== modelUrl)
      .map((p) => `provider ${p.name}`),
    ...mcp.servers
      .filter((s) => !s.url.startsWith(mcpBase))
      .map((s) => `mcp server ${s.name}`),
    ...(tools.access.mode === "off" ? [] : [`web access ${tools.access.mode}`]),
    ...(tools.search.provider === null
      ? []
      : [`search provider ${tools.search.provider}`]),
  ];
  if (wrong.length > 0) {
    throw new Error(`not on the fakes, refusing to run: ${wrong.join(", ")}`);
  }
}
