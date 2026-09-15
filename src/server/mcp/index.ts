// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentServer } from "../../shared/contracts/mcp.ts";
import { classify, promptSnapshot, wireName } from "../../shared/mcp.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import {
  cut,
  type Fetcher,
  type ListedTool,
  scrub,
  withClient,
} from "./client.ts";
import { discover, fingerprint } from "./discover.ts";
import {
  MAX_INSTRUCTIONS,
  MAX_SERVER_NAME,
  MAX_SERVER_VERSION,
} from "./limits.ts";
import { RefreshCoordinator } from "./refresh.ts";
import { resultText } from "./result.ts";
import { routes } from "./routes.ts";
import { McpServerStore } from "./store.ts";

export type OfferedMcpTool = {
  name: string;
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
  render: (markdown: string, streaming?: boolean) => string;
};

export type Mcp = {
  store: McpServerStore;
  routes: RouteDescriptor[];
  offered(agentServers: AgentServer[]): OfferedServer[];
  refreshSoon(id: string, observed: string): void;
  start(): void;
  close(): Promise<void>;
  agentServers(agentId: string): AgentServer[];
  setAgentServers(agentId: string, rows: AgentServer[]): void;
  call(
    server: OfferedServer,
    tool: OfferedMcpTool,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<string>;
};

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
  const offered = (links: AgentServer[]): OfferedServer[] => {
    const selected: OfferedServer[] = [];
    for (const link of links) {
      const server = store.byId(link.serverId);
      if (server === null) continue;
      const read = server.read && link.read;
      const write = server.write && link.write;
      if (!read && !write) continue;
      const sides = classify(server.name, server.tools, {
        read: server.readPatterns,
        write: server.writePatterns,
        excluded: server.excludedPatterns,
      });
      const tools: OfferedMcpTool[] = [];
      for (const row of server.tools) {
        const side = sides.get(row.name);
        const name = wireName(server.name, row.name);
        if (
          name === null ||
          row.unusable !== null ||
          !((side === "read" && read) || (side === "write" && write))
        ) {
          continue;
        }
        try {
          tools.push({
            name: row.name,
            wireName: name,
            description: row.description,
            inputSchema: JSON.parse(row.inputSchema),
            schemaJson: row.inputSchema,
          });
        } catch {}
      }
      if (tools.length === 0) continue;
      tools.sort((a, b) => a.wireName.localeCompare(b.wireName));
      selected.push({
        id: server.id,
        name: server.name,
        url: server.url,
        keyName: server.keyName,
        timeoutMs: server.timeoutMs,
        fingerprint: server.fingerprint,
        instructions:
          server.instructionsOn && server.instructions !== ""
            ? server.instructions
            : null,
        tools,
      });
    }
    selected.sort((a, b) => a.name.localeCompare(b.name));
    const snapshot = promptSnapshot(
      selected.map((server) => ({
        name: server.name,
        instructions: server.instructions,
        tools: server.tools.map((tool) => ({
          wireName: tool.wireName,
          description: tool.description,
          schemaJson: tool.schemaJson,
        })),
      })),
      () => "",
    );
    for (const name of snapshot.leftForSchemas) {
      deps.log(`server ${name} left out: its tools are over the schema cap`);
    }
    for (const name of snapshot.leftForInstructions) {
      deps.log(`server ${name} instructions left out: over the prompt cap`);
    }
    const included = new Set(snapshot.included);
    return selected.filter((server) => included.has(server.name));
  };
  const area: Mcp = {
    store,
    routes: [],
    offered,
    refreshSoon: (id, observed) => coordinator.refreshSoon(id, observed),
    start: () => coordinator.start(),
    close: () => coordinator.close(),
    agentServers: (agentId) => store.agentServers(agentId),
    setAgentServers: (agentId, links) => store.setAgentServers(agentId, links),
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
        const mapped = resultText(
          scrub(
            await client.callTool(tool.name, args, definition, {
              signal: options.signal,
              timeoutMs: options.timeoutMs,
            }),
            key,
          ),
        );
        if (mapped.isError) throw new Error(mapped.text);
        return mapped.text;
      });
    },
  };
  area.routes = routes({
    store,
    coordinator,
    clock: deps.clock,
    log: deps.log,
    hasSecret: (name) => deps.secret(name) !== null,
    keys: deps.keys,
    render: deps.render,
    discover: runDiscovery,
  });
  return area;
}

export { type DiscoveryResult, discover, fingerprint } from "./discover.ts";
export { RefreshCoordinator } from "./refresh.ts";
export { resultText } from "./result.ts";
export { type McpServerRow, McpServerStore, summary } from "./store.ts";
