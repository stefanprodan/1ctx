// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What provisioning reads of the instance, from each area's rows when it
// asks: every object by kind and name, and a team project's docs.

import type { KnowledgeCaps } from "../limits/index.ts";
import type { Inventory, ProjectDocs } from "./parse.ts";

type Named = { list(): { name: string }[] };

export type InventorySources = {
  users: { list(): { username: string }[] };
  projects: {
    teamProjectIds(): string[];
    byId(id: string): { name: string } | null;
  };
  credentials: Named;
  providers: Named;
  skills: { summaries(agentNames: () => string[]): { name: string }[] };
  mcp: Named;
  agents: Named;
};

export function inventoryOf(sources: InventorySources): Inventory {
  const names = sources.users.list().map((row) => row.username);
  return {
    User: names.length ? names : ["admin"],
    Project: sources.projects
      .teamProjectIds()
      .map((id) => sources.projects.byId(id)!.name),
    Credential: sources.credentials.list().map((row) => row.name),
    Provider: sources.providers.list().map((row) => row.name),
    Skill: sources.skills.summaries(() => []).map((row) => row.name),
    McpServer: sources.mcp.list().map((row) => row.name),
    Agent: sources.agents.list().map((row) => row.name),
    Tool: ["web", "websearch", "visualize"],
  };
}

export function projectDocsOf(sources: {
  projects: InventorySources["projects"];
  limits: { current(): KnowledgeCaps };
  docs: { list(projectId: string): { name: string; bytes: number }[] };
}): ProjectDocs {
  return (name) => {
    const id = sources.projects
      .teamProjectIds()
      .find((id) => sources.projects.byId(id)?.name === name);
    return {
      caps: sources.limits.current(),
      live: id === undefined ? [] : sources.docs.list(id),
    };
  };
}
