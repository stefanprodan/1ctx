// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents list and an agent's page for every signed-in user: what a
// send would offer it now, and its token counts.

import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
  DirectoryAgentsResponse,
} from "../../shared/api/directory.ts";
import type { McpScope } from "../../shared/contracts/mcp.ts";
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import type { Scoped } from "../../shared/mcp.ts";
import { firstSentence, MAX_CATALOG_LINE } from "../../shared/text.ts";
import { WEB_TOOLS, type Wire } from "../../shared/words.ts";
import { parseName, parseNoQuery } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { tokens } from "../lib/tokens.ts";
import type { OfferedServer } from "../mcp/index.ts";
import { type ChatTool, wireTokens } from "../providers/index.ts";
import { parseZoneQuery } from "../usage/index.ts";
import type { AgentTotalPort, ProvidersPort } from "./routes.ts";
import type { AgentRow, AgentStore } from "./store.ts";

// the tools the page lists; the skill and MCP tools are shown as what
// they carry
const LISTED = new Set<string>([
  "datetime",
  ...WEB_TOOLS,
  "bash",
  "memory_edit",
  "delegate",
]);

// the page's lists read by name, whatever order a send offers them in
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

// the lean MCP schemas as the wire carries them in all mode, the count
// the token cap reads whatever mode the send resolved to
function schemaTokens(servers: OfferedServer[], wire: Wire | null): number {
  const schemas = servers.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description,
      parameters: tool.wireInputSchema,
    })),
  );
  return wireTokens(schemas, wire);
}

export type SkillsListPort = {
  forAgent(agentId: string): OfferedSkill[];
  versions(
    agentId: string,
  ): { id: string; digest: string; fetchedAt: number; files: number }[];
  bodyText(id: string): string | null;
};

// the tools a send of the agent would be offered: a closure, since
// tools are built after agents
export type ToolsPort = {
  offered(
    now: number,
    agentId: string,
    agentServers: AgentRow["servers"],
    mode: AgentRow["mcpMode"],
    scope: {
      projectId: string | null;
      automation: null;
      phase: "main";
      chat: { sessionId: string; userId: string };
      delegate: boolean;
      mcpChosen: true;
    },
  ): {
    tools: ChatTool[];
    search: string | null;
    mcp: OfferedServer[];
    mcpCatalog: string;
  };
};

// an agent's days in every project, the usage area's answer
export type UsagePort = AgentTotalPort & {
  agentDays(agentId: string, timeZone: string): DirectoryAgentDaysResponse;
};

// what the viewer sees, for the scope of the agent's servers
export type DirectoryAccessPort = {
  visibleProjectIds(userId: string): string[] | null;
};

export type DirectoryMcpPort = {
  scopes(): (Scoped & { id: string })[];
};

export type DirectoryProjectsPort = {
  byId(id: string): { name: string } | null;
};

// where a server reaches as the viewer may know it: all, or the listed
// projects the viewer sees, every one for an admin; null leaves the
// server out
function reachOf(
  row: (Scoped & { id: string }) | undefined,
  admin: boolean,
  visible: ReadonlySet<string>,
): { scope: McpScope; projectIds: string[] } | null {
  if (row === undefined) return null;
  if (row.scope === "all") return { scope: "all", projectIds: [] };
  const projectIds = admin
    ? [...row.projectIds]
    : row.projectIds.filter((id) => visible.has(id));
  return admin || projectIds.length > 0
    ? { scope: "projects", projectIds }
    : null;
}

export type DirectoryDeps = {
  store: AgentStore;
  access: DirectoryAccessPort;
  mcp: DirectoryMcpPort;
  projects: DirectoryProjectsPort;
  usage: UsagePort;
  providers: Pick<ProvidersPort, "byId">;
  skills: SkillsListPort;
  tools: ToolsPort;
  clock: Clock;
};

// a body is up to 40,000 characters and an agent carries up to twenty,
// so a count is kept per skill until its digest moves; the cap bounds
// the map when skills come and go
const MAX_COUNTED_SKILLS = 500;

export function directoryRoutes(deps: DirectoryDeps): RouteDescriptor[] {
  const counted = new Map<string, { digest: string; tokens: number }>();
  const bodyTokens = (id: string, digest: string): number => {
    const held = counted.get(id);
    if (held !== undefined && held.digest === digest) return held.tokens;
    const n = tokens(deps.skills.bodyText(id) ?? "");
    counted.delete(id);
    if (counted.size >= MAX_COUNTED_SKILLS) {
      const oldest = counted.keys().next().value;
      if (oldest !== undefined) counted.delete(oldest);
    }
    counted.set(id, { digest, tokens: n });
    return n;
  };
  return [
    {
      method: "GET",
      path: "/api/directory/agents",
      policy: "authenticated",
      handle(_req, ctx) {
        parseNoQuery(ctx.url);
        const body: DirectoryAgentsResponse = {
          agents: deps.store
            .list()
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              avatar: agent.avatar,
              default: agent.default,
              model: agent.model.id,
            }))
            .sort(byName),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/directory/agents/:name",
      policy: "authenticated",
      handle(_req, ctx) {
        const found = deps.store.byName(parseName(ctx.params.name));
        if (found === null) throw new NotFound("no such agent");
        const principal = ctx.principal!;
        const visible = new Set(
          deps.access.visibleProjectIds(principal.userId) ?? [],
        );
        const scopes = new Map(deps.mcp.scopes().map((row) => [row.id, row]));
        const reach = new Map(
          found.servers.flatMap((link) => {
            const reached = reachOf(
              scopes.get(link.serverId),
              principal.role === "admin",
              visible,
            );
            return reached === null ? [] : [[link.serverId, reached] as const];
          }),
        );
        // one set for the list, its tokens, the tools' total and the agent
        const agent = {
          ...found,
          servers: found.servers.filter((link) => reach.has(link.serverId)),
        };
        const names = (ids: string[]) =>
          ids
            .flatMap((id) => {
              const name = deps.projects.byId(id)?.name;
              return name === undefined ? [] : [name];
            })
            .sort((a, b) => a.localeCompare(b));
        const offered = agent.model.tools
          ? deps.tools.offered(
              deps.clock(),
              agent.id,
              agent.servers,
              agent.mcpMode,
              // a chat's send, with no chat: the schema is counted and
              // never run; no project, the links chosen by scope above
              {
                projectId: null,
                automation: null,
                phase: "main",
                chat: { sessionId: "", userId: "" },
                delegate: agent.subagents,
                mcpChosen: true,
              },
            )
          : { tools: [], search: null, mcp: [], mcpCatalog: "" };
        const versions = deps.skills.versions(agent.id);
        const byId = new Map(versions.map((v) => [v.id, v]));
        // counted as the agent's own wire sends the schemas
        const provider = deps.providers.byId(agent.providerId);
        const wire = provider?.wire ?? null;
        const body: DirectoryAgentResponse = {
          agent,
          provider: provider?.name ?? "",
          wire,
          skills: deps.skills
            .forAgent(agent.id)
            .map((skill) => ({
              ...skill,
              fetchedAt: byId.get(skill.id)?.fetchedAt ?? 0,
              // SKILL.md is a file too
              files: (byId.get(skill.id)?.files ?? 0) + 1,
            }))
            .sort(byName),
          tools: offered.tools
            .filter((tool) => LISTED.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: firstSentence(tool.description, MAX_CATALOG_LINE),
              provider: tool.name === "websearch" ? offered.search : null,
            }))
            .sort(byName),
          mcp: {
            servers: offered.mcp
              .map((server) => {
                const reached = reach.get(server.id);
                return {
                  name: server.name,
                  tools: server.tools.length,
                  checkedAt: server.checkedAt,
                  refreshFailedAt: server.refreshFailedAt,
                  scope: reached?.scope ?? "all",
                  projects: names(reached?.projectIds ?? []),
                };
              })
              .sort(byName),
            tokens: schemaTokens(offered.mcp, wire),
          },
          tokens: {
            prompt: tokens(agent.prompt),
            skills: versions.reduce(
              (n, v) => n + bodyTokens(v.id, v.digest),
              0,
            ),
            // the schemas as the chat body carries them, skill tools
            // included
            tools: wireTokens(offered.tools, wire),
          },
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/directory/agents/:name/days",
      policy: "authenticated",
      handle(_req, ctx) {
        const agent = deps.store.byName(parseName(ctx.params.name));
        if (agent === null) throw new NotFound("no such agent");
        const timeZone = parseZoneQuery(ctx.url);
        return json(deps.usage.agentDays(agent.id, timeZone));
      },
    },
  ];
}
