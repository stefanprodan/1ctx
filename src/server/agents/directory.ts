// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's page, for every signed-in user: how it is configured. The
// composer's route already sends the whole row, so the page adds only
// what a user cannot see elsewhere: the provider's name, the skills
// with their descriptions and when they were fetched, the built-in tools
// a send would offer it now with websearch's provider, and token counts.
// The tools are the tools area's answer at this moment, none when the
// model does not accept tools. The list is built-ins alone, memory_edit
// as a chat is offered it; skill and MCP schemas still count because the
// provider request carries them. Its days are the agent's turns in
// every project as one series, whoever asks.

import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
} from "../../shared/api/directory.ts";
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import { WEB_TOOLS } from "../../shared/words.ts";
import type { Clock } from "../lib/clock.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { tokens } from "../lib/tokens.ts";
import type { OfferedServer } from "../mcp/index.ts";
import { type ChatTool, wireTokens } from "../providers/index.ts";
import { parseZoneQuery } from "../usage/index.ts";
import { parseAgentName } from "./parse.ts";
import type { ProvidersPort } from "./routes.ts";
import { type AgentRow, type AgentStore, summary } from "./store.ts";

// the tools the page lists; the skill and MCP tools are shown as what
// they carry
const LISTED = new Set<string>([
  "datetime",
  ...WEB_TOOLS,
  "bash",
  "memory_edit",
]);

// the page's lists read by name, whatever order a send offers them in
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

// the lean MCP schemas as the wire carries them in all mode, the count
// the token cap reads whatever mode the send resolved to
function schemaTokens(servers: OfferedServer[]): number {
  const schemas = servers.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description,
      parameters: tool.wireInputSchema,
    })),
  );
  return wireTokens(schemas);
}

export type SkillsListPort = {
  forAgent(agentId: string): OfferedSkill[];
  versions(
    agentId: string,
  ): { id: string; digest: string; fetchedAt: number }[];
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
    },
  ): {
    tools: ChatTool[];
    search: string | null;
    mcp: OfferedServer[];
    mcpCatalog: string;
  };
};

// an agent's days in every project, the usage area's answer
export type UsagePort = {
  agentDays(agentId: string, timeZone: string): DirectoryAgentDaysResponse;
};

export type DirectoryDeps = {
  store: AgentStore;
  usage: UsagePort;
  providers: Pick<ProvidersPort, "byId">;
  skills: SkillsListPort;
  tools: ToolsPort;
  clock: Clock;
};

// a body is up to 40,000 characters and an agent carries up to twenty,
// so a count is kept per skill until its digest moves; the cap bounds
// the map when skills come and go
export const MAX_COUNTED_SKILLS = 500;

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
      path: "/api/directory/agents/:name",
      policy: "authenticated",
      handle(_req, ctx) {
        const agent = deps.store.byName(parseAgentName(ctx.params.name));
        if (agent === null) throw new NotFound("no such agent");
        const offered = agent.model.tools
          ? deps.tools.offered(
              deps.clock(),
              agent.id,
              agent.servers,
              agent.mcpMode,
              // a chat's send, with no chat: the schema is counted and
              // never run
              {
                projectId: null,
                automation: null,
                phase: "main",
                chat: { sessionId: "", userId: "" },
              },
            )
          : { tools: [], search: null, mcp: [], mcpCatalog: "" };
        const versions = deps.skills.versions(agent.id);
        const fetched = new Map(versions.map((v) => [v.id, v.fetchedAt]));
        const body: DirectoryAgentResponse = {
          agent: summary(agent),
          provider: deps.providers.byId(agent.providerId)?.name ?? "",
          skills: deps.skills
            .forAgent(agent.id)
            .map((skill) => ({
              ...skill,
              fetchedAt: fetched.get(skill.id) ?? 0,
            }))
            .sort(byName),
          tools: offered.tools
            .filter((tool) => LISTED.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              provider: tool.name === "websearch" ? offered.search : null,
            }))
            .sort(byName),
          mcp: {
            servers: offered.mcp
              .map((server) => {
                const link = agent.servers.find(
                  (s) => s.serverId === server.id,
                );
                return {
                  name: server.name,
                  read: link?.read ?? false,
                  write: link?.write ?? false,
                  tools: server.tools.length,
                  checkedAt: server.checkedAt,
                  refreshFailedAt: server.refreshFailedAt,
                };
              })
              .sort(byName),
            tokens: schemaTokens(offered.mcp),
          },
          tokens: {
            prompt: tokens(agent.prompt),
            skills: versions.reduce(
              (n, v) => n + bodyTokens(v.id, v.digest),
              0,
            ),
            // the schemas as the chat body carries them, skill tools
            // included
            tools: wireTokens(offered.tools),
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
        const agent = deps.store.byName(parseAgentName(ctx.params.name));
        if (agent === null) throw new NotFound("no such agent");
        const timeZone = parseZoneQuery(ctx.url);
        return json(deps.usage.agentDays(agent.id, timeZone));
      },
    },
  ];
}
