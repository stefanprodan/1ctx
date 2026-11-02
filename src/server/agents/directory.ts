// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents list and an agent's page for every signed-in user: what a
// send would offer it now, and its token counts.

import type { AgentMcpResponse } from "../../shared/api/agents.ts";
import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
  DirectoryAgentsResponse,
} from "../../shared/api/directory.ts";
import type { McpSide, ServerSide } from "../../shared/contracts/mcp.ts";
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import { SIDE_RANK } from "../../shared/mcp.ts";
import {
  CATALOG_LEAD,
  CATALOG_OPENINGS,
  mcpCatalog,
} from "../../shared/mcp-catalog.ts";
import { firstSentence, MAX_CATALOG_LINE } from "../../shared/text.ts";
import { type ProjectKind, WEB_TOOLS, type Wire } from "../../shared/words.ts";
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

// the catalog's lead and wrapper, which a send carries once, not per server
const CATALOG_FRAME = tokens(
  `${CATALOG_LEAD}\n${CATALOG_OPENINGS[0]}\n\n<available_mcp_tools>\n</available_mcp_tools>`,
);

// one server's share of the agent's MCP tokens in its mode: its catalog
// lines in catalog, else its schemas, which the auto cap reads
function serverTokens(
  server: OfferedServer,
  mode: AgentRow["mcpMode"],
  wire: Wire | null,
): number {
  if (mode !== "catalog") return schemaTokens([server], wire);
  const { text } = mcpCatalog([
    {
      name: server.name,
      instructions: null,
      tools: server.tools.map((tool) => ({
        wireName: tool.wireName,
        description: tool.description,
        schemaJson: tool.schemaJson,
      })),
    },
  ]);
  return text === "" ? 0 : Math.max(0, tokens(text) - CATALOG_FRAME);
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
    mcpOn: boolean,
    mode: AgentRow["mcpMode"],
    scope: {
      projectId: string | null;
      automation: null;
      phase: "main";
      chat: { sessionId: string; userId: string };
      delegate: boolean;
      mcpSides: ServerSide[];
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

// what the viewer sees, for where the agent's servers are on
export type DirectoryAccessPort = {
  visibleProjectIds(userId: string): string[] | null;
};

export type DirectoryMcpPort = {
  // per server, the side it gives in each project named
  sidesIn(projectIds: readonly string[]): Map<string, Map<string, McpSide>>;
  // per server, the team projects it is on, the personal count and the
  // widest side
  whereOn(): Map<
    string,
    { teams: Map<string, McpSide>; personal: number; widest: McpSide }
  >;
};

export type DirectoryProjectsPort = {
  byId(id: string): { name: string; kind: ProjectKind } | null;
};

type Reach = { projectIds: string[]; personal: number; widest: McpSide };

// where each server is on as the viewer may know it: in the projects
// they see, every project for an admin with personal ones as a count
function reachOf(
  deps: Pick<DirectoryDeps, "access" | "mcp">,
  userId: string,
  admin: boolean,
): Map<string, Reach> {
  const out = new Map<string, Reach>();
  if (admin) {
    for (const [id, where] of deps.mcp.whereOn()) {
      if (where.widest === "off") continue;
      out.set(id, {
        projectIds: [...where.teams.keys()],
        personal: where.personal,
        widest: where.widest,
      });
    }
    return out;
  }
  const visible = deps.access.visibleProjectIds(userId) ?? [];
  for (const [id, sides] of deps.mcp.sidesIn(visible)) {
    let widest: McpSide = "off";
    for (const side of sides.values()) {
      if (SIDE_RANK[side] > SIDE_RANK[widest]) widest = side;
    }
    out.set(id, { projectIds: [...sides.keys()], personal: 0, widest });
  }
  return out;
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
        const agent = deps.store.byName(parseName(ctx.params.name));
        if (agent === null) throw new NotFound("no such agent");
        const principal = ctx.principal!;
        // one set for the list, its tokens, the tools' total and the agent;
        // an agent off MCP has none
        const reach = agent.mcp
          ? reachOf(deps, principal.userId, principal.role === "admin")
          : new Map<string, Reach>();
        const sides: ServerSide[] = [...reach].flatMap(([serverId, r]) =>
          r.widest === "off" ? [] : [{ serverId, side: r.widest }],
        );
        // the viewer's own personal project reads Personal
        const names = (ids: string[]) =>
          ids
            .flatMap((id) => {
              const project = deps.projects.byId(id);
              if (project === null) return [];
              return [project.kind === "personal" ? "Personal" : project.name];
            })
            .sort((a, b) => a.localeCompare(b));
        const offered = agent.model.tools
          ? deps.tools.offered(
              deps.clock(),
              agent.id,
              agent.mcp,
              agent.mcpMode,
              // a chat's send, with no chat: the schema is counted and
              // never run; no project, the sides chosen above
              {
                projectId: null,
                automation: null,
                phase: "main",
                chat: { sessionId: "", userId: "" },
                delegate: agent.subagents,
                mcpSides: sides,
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
                  projects: names(reached?.projectIds ?? []),
                  personal: reached?.personal ?? 0,
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
      // the agent's MCP tab: every server on its own switches, whichever
      // projects choose it, so each row is the most it costs
      method: "GET",
      path: "/api/agents/:id/mcp",
      policy: "admin",
      handle(_req, ctx) {
        const agent = deps.store.byId(ctx.params.id);
        if (agent === null) throw new NotFound("no such agent");
        const wire = deps.providers.byId(agent.providerId)?.wire ?? null;
        const sides: ServerSide[] = [...deps.mcp.whereOn().keys()].map(
          (serverId) => ({ serverId, side: "write" }),
        );
        const offered = agent.model.tools
          ? deps.tools.offered(deps.clock(), agent.id, true, "all", {
              projectId: null,
              automation: null,
              phase: "main",
              chat: { sessionId: "", userId: "" },
              delegate: false,
              mcpSides: sides,
            }).mcp
          : [];
        const body: AgentMcpResponse = {
          servers: offered.map((server) => ({
            id: server.id,
            tokens: serverTokens(server, agent.mcpMode, wire),
          })),
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
