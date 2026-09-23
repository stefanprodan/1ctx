// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SwitchableServer } from "../../shared/api/sessions.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import {
  classify,
  type McpDigest,
  offeredServers,
  type PromptServer,
  promptSnapshot,
  splitWireName,
  wireName,
} from "../../shared/mcp.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import {
  cut,
  type Fetcher,
  type ListedTool,
  scrub,
  validateArguments,
  withClient,
} from "./client.ts";
import { discover, fingerprint } from "./discover.ts";
import {
  MAX_INSTRUCTIONS,
  MAX_SERVER_NAME,
  MAX_SERVER_VERSION,
} from "./limits.ts";
import { RefreshCoordinator } from "./refresh.ts";
import { type McpCallOutput, resultText } from "./result.ts";
import { routes } from "./routes.ts";
import { type McpServerRow, McpServerStore } from "./store.ts";

export {
  parseMcpKeyName,
  parsePatterns,
  parseTimeout,
  parseUrl,
} from "./parse.ts";

export type OfferedMcpTool = {
  name: string;
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  wireInputSchema: Record<string, unknown>;
  schemaJson: string;
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

export type McpPrompt = {
  text: string;
  digest: McpDigest;
};

export type McpOffer = {
  servers: OfferedServer[];
  prompt: ReturnType<typeof promptSnapshot>;
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
  render: (markdown: string, streaming?: boolean) => string;
  capabilities: { forget(key: string): void };
};

export type Mcp = {
  store: McpServerStore;
  routes: RouteDescriptor[];
  offered(agentServers: AgentServer[]): McpOffer;
  switchable(links: AgentServer[]): SwitchableServer[];
  // the same per agent id over one read of the catalogs, agents without a
  // switchable server left out
  switchableBy(
    agents: { id: string; servers: AgentServer[] }[],
  ): Record<string, SwitchableServer[]>;
  isWrite(name: string): boolean;
  refreshSoon(id: string, observed: string): void;
  start(): void;
  close(): Promise<void>;
  agentServers(agentId: string): AgentServer[];
  setAgentServers(agentId: string, rows: AgentServer[]): void;
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

function switchableOver(
  rows: McpServerRow[],
  links: AgentServer[],
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

function promptRows(
  rows: McpServerRow[],
  links: AgentServer[],
): PromptServer[] {
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

function offeredRow(row: McpServerRow, prompt: PromptServer): OfferedServer {
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
  const offered = (links: AgentServer[]): McpOffer => {
    const rows = store.list();
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
    offered,
    switchable(links) {
      return links.length === 0 ? [] : switchableOver(store.list(), links);
    },
    switchableBy(agents) {
      if (agents.every((agent) => agent.servers.length === 0)) return {};
      const rows = store.list();
      return Object.fromEntries(
        agents.flatMap((agent) => {
          const servers =
            agent.servers.length === 0
              ? []
              : switchableOver(rows, agent.servers);
          return servers.length === 0 ? [] : [[agent.id, servers]];
        }),
      );
    },
    isWrite(name) {
      const split = splitWireName(name);
      if (split === null) return false;
      const server = store.byName(split.server);
      if (server === null) return false;
      return (
        classify(server.name, server.tools, {
          read: server.readPatterns,
          write: server.writePatterns,
          excluded: server.excludedPatterns,
        }).get(split.tool) === "write"
      );
    },
    refreshSoon: (id, observed) => coordinator.refreshSoon(id, observed),
    start: () => coordinator.start(),
    close: () => coordinator.close(),
    agentServers: (agentId) => store.agentServers(agentId),
    setAgentServers: (agentId, links) => store.setAgentServers(agentId, links),
    validateArguments,
    async call(server, tool, args, options) {
      const key = server.keyName === null ? null : deps.secret(server.keyName);
      return withClient(deps, server, key, options, async (client) => {
        const raw = scrub(client.info(), key);
        const identity = {
          serverName: cut(raw.serverName, MAX_SERVER_NAME),
          serverVersion: cut(raw.serverVersion, MAX_SERVER_VERSION),
          instructions: cut(raw.instructions.trim(), MAX_INSTRUCTIONS),
        };
        const observed = fingerprint(identity);
        if (observed !== server.fingerprint) {
          coordinator.refreshSoon(server.id, observed);
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
        if (mapped.isError) throw new Error(mapped.text);
        return {
          text: mapped.text,
          content: Array.isArray(result.content) ? result.content : [],
          structured: result.structuredContent,
        };
      });
    },
  };
  area.routes = routes({
    db: deps.db,
    store,
    capabilities: deps.capabilities,
    coordinator,
    clock: deps.clock,
    log: deps.log,
    hasSecret: (name) => deps.secret(name) !== null,
    keys: deps.keys,
    callTimeoutMs: deps.callTimeoutMs,
    render: deps.render,
    discover: runDiscovery,
  });
  return area;
}

export { type DiscoveryResult, discover, fingerprint } from "./discover.ts";
export { changeNote } from "./note.ts";
export { RefreshCoordinator } from "./refresh.ts";
export {
  type McpCallOutput,
  type McpContent,
  resultText,
} from "./result.ts";
export { type McpServerRow, McpServerStore, summary } from "./store.ts";
