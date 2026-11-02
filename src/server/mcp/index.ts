// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SwitchableServer } from "../../shared/api/sessions.ts";
import type { McpSide, ServerSide } from "../../shared/contracts/mcp.ts";
import {
  offeredServers,
  offeredSide,
  promptSnapshot,
  type SidedServer,
  wireName,
} from "../../shared/mcp.ts";
import type { ProjectKind } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { ToolError } from "../lib/errors.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import { sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import type { Fetcher } from "../providers/index.ts";
import { type ListedTool, scrub, withClient } from "./client.ts";
import { discover, identityOf } from "./discover.ts";
import { projectRoutes } from "./project-routes.ts";
import { RefreshCoordinator } from "./refresh.ts";
import { type McpCallOutput, resultText } from "./result.ts";
import { routes, type UsagePort } from "./routes.ts";
import { choicesIn, type ProjectChoices, whereOn } from "./scope.ts";
import {
  type McpScopeRow,
  type McpServerRow,
  McpServerStore,
} from "./store.ts";
import { validateArguments } from "./validate.ts";

export { changeNote } from "./note.ts";
export {
  parseMcpKeyName,
  parsePatterns,
  parseSide,
  parseTimeout,
  parseUrl,
} from "./parse.ts";
export type { McpCallOutput, McpContent } from "./result.ts";
export { type McpScopeRow, McpServerStore } from "./store.ts";

export type OfferedMcpTool = {
  name: string;
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  wireInputSchema: Record<string, unknown>;
  schemaJson: string;
  side: "read" | "write";
};

export type OfferedServer = {
  id: string;
  name: string;
  url: string;
  keyName: string | null;
  timeoutMs: number | null;
  fingerprint: string;
  instructions: string | null;
  tools: OfferedMcpTool[];
  // when the list was last discovered, and when a refresh last failed
  // since, for the agent's page
  checkedAt: number;
  refreshFailedAt: number | null;
};

export type McpOffer = {
  servers: OfferedServer[];
  prompt: ReturnType<typeof promptSnapshot>;
};

// what a send without MCP is offered
export const NO_OFFER: McpOffer = {
  servers: [],
  prompt: {
    text: "",
    included: [],
    leftForSchemas: [],
    leftForInstructions: [],
    digest: {},
  },
};

export type McpCallOptions = {
  signal: AbortSignal;
  timeoutMs: number;
  bodyBytes: number;
};

export type McpDeps = {
  db: Db;
  fetcher: Fetcher;
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
  version: string;
  // the names of the mcp- key files, for the form; never a value
  keys: () => string[];
  // the limits' call timeout of the moment, for the form's hint
  callTimeoutMs: () => number;
  render: (markdown: string) => string;
  capabilities: { forget(key: string): void };
  // a closure, sessions is built later
  usage: UsagePort;
  // closures, both built later: a project's kind and name, a user's
  // personal project, and the project a principal may see, else a 404
  projects: {
    byId(id: string): { kind: string; name: string } | null;
    personal(userId: string): { id: string } | null;
  };
  access: {
    project(
      principal: Principal,
      id: string,
    ): { id: string; kind: ProjectKind };
  };
};

// where a server is on for one viewer's lists: the projects by id with
// the side each gives, the personal count, and the widest side
export type McpWhere = {
  teams: Map<string, McpSide>;
  personal: number;
  widest: McpSide;
};

// what an offer in a project leaves out: the servers a chat or a run
// turned off, and the write side for a subagent
export type OfferOptions = { off?: ReadonlySet<string>; readOnly?: boolean };

export type Mcp = {
  store: McpServerStore;
  routes: RouteDescriptor[];
  // the project's chosen servers on their sides; none with no project
  offered(projectId: string | null, options?: OfferOptions): McpOffer;
  // the sides as given, for the directory, which chose them by the
  // viewer's projects itself
  offeredSides(sides: ServerSide[]): McpOffer;
  // the servers a send in the project is offered, with tool counts
  switchable(projectId: string): SwitchableServer[];
  // the servers on in the project, on their sides, in name order
  sides(projectId: string): ServerSide[];
  // every server's endpoint and grants, its tools unread
  scopes(): McpScopeRow[];
  // per server, the sides it gives in each of the projects named
  sidesIn(projectIds: readonly string[]): Map<string, Map<string, McpSide>>;
  // per server, where it is on in every project
  whereOn(): Map<string, McpWhere>;
  refreshSoon(id: string, observed: string): Promise<void>;
  start(): void;
  close(): Promise<void>;
  validateArguments(
    schema: Record<string, unknown>,
    input: Record<string, unknown>,
  ): string | null;
  call(
    server: OfferedServer,
    tool: OfferedMcpTool,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpCallOutput>;
};

// each row on in the project with its side, in the rows' order; a
// missing project gets none
function sidedIn(
  rows: readonly McpScopeRow[],
  projectId: string,
  project: ProjectChoices | null,
): ServerSide[] {
  if (project === null) return [];
  const ref = { id: projectId, kind: project.kind };
  return rows.flatMap((row) => {
    const side = offeredSide(row, ref, project.sides.get(row.id));
    return side === "off" ? [] : [{ serverId: row.id, side }];
  });
}

function switchableOver(
  rows: McpServerRow[],
  links: ServerSide[],
): SwitchableServer[] {
  const counts = new Map(
    promptRows(rows, links).map((server) => [server.name, server.tools.length]),
  );
  return rows
    .flatMap((row) => {
      const tools = counts.get(row.name);
      return tools === undefined ? [] : [{ id: row.id, name: row.name, tools }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// each server's tools on the sides its own switches and patterns turn
// on, as an agent linked to both sides would get them
function toolCounts(rows: McpServerRow[]): Map<string, number> {
  const counts = new Map(
    promptRows(
      rows,
      rows.map((row) => ({ serverId: row.id, side: "write" as const })),
    ).map((server) => [server.name, server.tools.length]),
  );
  return new Map(rows.map((row) => [row.id, counts.get(row.name) ?? 0]));
}

function promptRows(rows: McpServerRow[], links: ServerSide[]): SidedServer[] {
  return offeredServers(
    rows.map((server) => ({
      id: server.id,
      name: server.name,
      read: server.read,
      write: server.write,
      instructionsOn: server.instructionsOn,
      instructions: server.instructions,
      readPatterns: server.readPatterns,
      writePatterns: server.writePatterns,
      excludedPatterns: server.excludedPatterns,
      tools: server.tools.map((tool) => ({
        name: tool.name,
        wireName: wireName(server.name, tool.name),
        unusable: tool.unusable,
        description: tool.description,
        schemaJson: tool.inputSchema,
      })),
    })),
    links,
  );
}

function offeredRow(row: McpServerRow, prompt: SidedServer): OfferedServer {
  const byWire = new Map(
    row.tools.flatMap((tool) => {
      const name = wireName(row.name, tool.name);
      return name === null ? [] : [[name, tool] as const];
    }),
  );
  const tools = prompt.tools.flatMap((tool) => {
    const stored = byWire.get(tool.wireName);
    if (stored === undefined) return [];
    try {
      return [
        {
          name: stored.name,
          wireName: tool.wireName,
          description: tool.description,
          inputSchema: JSON.parse(stored.inputSchema) as Record<
            string,
            unknown
          >,
          wireInputSchema: JSON.parse(tool.schemaJson) as Record<
            string,
            unknown
          >,
          schemaJson: tool.schemaJson,
          side: tool.side,
        },
      ];
    } catch {
      return [];
    }
  });
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    keyName: row.keyName,
    timeoutMs: row.timeoutMs,
    fingerprint: row.fingerprint,
    instructions: prompt.instructions,
    tools,
    checkedAt: row.checkedAt,
    refreshFailedAt: row.refreshFailedAt,
  };
}

export function mcpArea(deps: McpDeps): Mcp {
  const store = new McpServerStore(deps.db);
  const runDiscovery = (
    endpoint: { url: string; keyName: string | null },
    signal: AbortSignal,
  ) => {
    const key =
      endpoint.keyName === null ? null : deps.secret(endpoint.keyName);
    return discover(deps, endpoint, key, signal);
  };
  const coordinator = new RefreshCoordinator({
    store,
    clock: deps.clock,
    log: deps.log,
    discover: runDiscovery,
  });
  const offerOver = (rows: McpServerRow[], links: ServerSide[]): McpOffer => {
    const prompts = promptRows(rows, links);
    const snapshot = promptSnapshot(prompts, sha256);
    for (const name of snapshot.leftForSchemas) {
      deps.log.warn("server omitted", {
        server: name,
        reason: "schema cap",
      });
    }
    for (const name of snapshot.leftForInstructions) {
      deps.log.warn("server instructions omitted", {
        server: name,
        reason: "prompt cap",
      });
    }
    const included = new Set(snapshot.included);
    const byName = new Map(rows.map((row) => [row.name, row]));
    const servers = prompts
      .filter((prompt) => included.has(prompt.name))
      .flatMap((prompt) => {
        const row = byName.get(prompt.name);
        return row === undefined ? [] : [offeredRow(row, prompt)];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { servers, prompt: snapshot };
  };
  const area: Mcp = {
    store,
    routes: [],
    offered(projectId, options = {}) {
      if (projectId === null) return NO_OFFER;
      const rows = store.list();
      const sides = sidedIn(rows, projectId, store.choices(projectId))
        .filter((link) => !options.off?.has(link.serverId))
        .map((link) =>
          options.readOnly ? { ...link, side: "read" as const } : link,
        );
      return sides.length === 0 ? NO_OFFER : offerOver(rows, sides);
    },
    offeredSides: (sides) =>
      sides.length === 0 ? NO_OFFER : offerOver(store.list(), sides),
    switchable(projectId) {
      const rows = store.list();
      const sides = sidedIn(rows, projectId, store.choices(projectId));
      return sides.length === 0 ? [] : switchableOver(rows, sides);
    },
    sides: (projectId) =>
      sidedIn(store.scopes(), projectId, store.choices(projectId)),
    scopes: () => store.scopes(),
    sidesIn(projectIds) {
      const rows = store.scopes();
      const out = new Map<string, Map<string, McpSide>>();
      for (const [id, project] of choicesIn(deps.db, projectIds)) {
        for (const link of sidedIn(rows, id, project)) {
          const held = out.get(link.serverId) ?? new Map<string, McpSide>();
          held.set(id, link.side);
          out.set(link.serverId, held);
        }
      }
      return out;
    },
    whereOn: () => whereOn(deps.db, store.scopes()),
    refreshSoon: (id, observed) => coordinator.refreshSoon(id, observed),
    start: () => coordinator.start(),
    close: () => coordinator.close(),
    validateArguments,
    async call(server, tool, args, options) {
      const key = server.keyName === null ? null : deps.secret(server.keyName);
      return withClient(deps, server, key, options, async (client) => {
        const observed = identityOf(client.info(), key).fingerprint;
        if (observed !== server.fingerprint) {
          void coordinator.refreshSoon(server.id, observed);
        }
        const definition: ListedTool = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        };
        const result = scrub(
          await client.callTool(tool.name, args, definition, {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          }),
          key,
        );
        const mapped = resultText(result);
        // the server's own words are the model's, never the log's
        if (mapped.isError) {
          throw new ToolError(mapped.text, "MCP tool answered an error");
        }
        return {
          text: mapped.text,
          content: Array.isArray(result.content) ? result.content : [],
          structured: result.structuredContent,
        };
      });
    },
  };
  const teamName = (id: string) => {
    const project = deps.projects.byId(id);
    return project?.kind === "team" ? project.name : null;
  };
  area.routes = routes({
    db: deps.db,
    store,
    capabilities: deps.capabilities,
    coordinator,
    clock: deps.clock,
    hasSecret: (name) => deps.secret(name) !== null,
    keys: deps.keys,
    callTimeoutMs: deps.callTimeoutMs,
    render: deps.render,
    discover: runDiscovery,
    usage: deps.usage,
    teamName,
  });
  area.routes.push(
    ...projectRoutes({
      db: deps.db,
      store,
      access: deps.access,
      teamName,
      personal: (userId) => deps.projects.personal(userId),
      toolCounts: (rows) => toolCounts(rows),
    }),
  );
  return area;
}
