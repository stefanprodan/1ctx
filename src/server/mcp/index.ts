// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentServer } from "../../shared/contracts/mcp.ts";
import {
  type McpDigest,
  offeredServers,
  type PromptServer,
  promptSnapshot,
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
import { resultText } from "./result.ts";
import { routes } from "./routes.ts";
import { type McpServerRow, McpServerStore } from "./store.ts";

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
  render: (markdown: string, streaming?: boolean) => string;
};

export type Mcp = {
  store: McpServerStore;
  routes: RouteDescriptor[];
  offered(agentServers: AgentServer[]): McpOffer;
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
  ): Promise<string>;
};

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
      deps.log(`server ${name} left out: its tools are over the schema cap`);
    }
    for (const name of snapshot.leftForInstructions) {
      deps.log(`server ${name} instructions left out: over the prompt cap`);
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
export { changeNote } from "./note.ts";
export { RefreshCoordinator } from "./refresh.ts";
export { resultText } from "./result.ts";
export { type McpServerRow, McpServerStore, summary } from "./store.ts";
