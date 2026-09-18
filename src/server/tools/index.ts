// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Built-ins, skills and MCP tools are resolved once for a send. The
// runner keeps this snapshot and the area dispatches only through it.

import type {
  PatchToolRequest,
  ToolsResponse,
} from "../../shared/api/tools.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import {
  type McpMode,
  type SearchProvider,
  WEB_TOOLS,
  type WebTool,
} from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { Mcp, OfferedMcpTool, OfferedServer } from "../mcp/index.ts";
import type { MemoryCapability } from "../memory/index.ts";
import { type ToolCall, wireTokens } from "../providers/index.ts";
import type { MemorySnapshot } from "../sessions/index.ts";
import { datetimeTool } from "./builtin/datetime.ts";
import {
  makeMcpCatalogTools,
  mcpCallName,
  resolveMcpCall,
} from "./builtin/mcp.ts";
import { isMemoryTool, runMemory, type UnreadChats } from "./builtin/memory.ts";
import { makeSkillTools } from "./builtin/skill.ts";
import { makeVisualizeTool } from "./builtin/visualize.ts";
import {
  type FetchDependencies,
  makeWebfetchTool,
} from "./builtin/webfetch.ts";
import {
  makeWebsearchTool,
  type SearchDependencies,
} from "./builtin/websearch.ts";
import { builtinCatalog, fillYear, parametersHtml } from "./catalog.ts";
import { offered, type SkillsPort } from "./offer.ts";
import { Registry } from "./registry.ts";
import { routes } from "./routes.ts";
import { ToolStore } from "./store.ts";
import type {
  MemoryScope,
  Offered,
  Tool,
  ToolContext,
  ToolResult,
} from "./types.ts";

export { DEFAULT_TIMEZONE, formatDatetime } from "./builtin/datetime.ts";
export { isMemoryTool, MEMORY_WRITE_RULES } from "./builtin/memory.ts";
export { TOOL_CAPS } from "./limits.ts";
export type { SkillsPort } from "./offer.ts";
export { parseHosts, parseToolName, parseToolPatch } from "./parse.ts";
export { type ToolRow, ToolStore } from "./store.ts";
export type {
  MemoryHandle,
  MemoryScope,
  Offered,
  Tool,
  ToolBudget,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "./types.ts";

export type ToolsDeps = {
  db: Db;
  fetcher: typeof fetch;
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
  version: string;
  render: (markdown: string, streaming: boolean) => string;
  skills: SkillsPort;
  mcp?: Pick<Mcp, "offered" | "call" | "validateArguments">;
  memory?: Pick<MemoryCapability, "work">;
  sessions?: {
    memorySnapshot(projectId: string, sessionId: string): MemorySnapshot | null;
  };
  markers?: {
    unread(
      automationId: string,
      projectId: string,
      cap: number,
      exclude: readonly string[],
    ): UnreadChats;
  };
  fetchDeps?: FetchDependencies;
  searchDeps?: SearchDependencies;
};

export type Tools = {
  offered(
    now: number,
    agentId: string,
    agentServers?: AgentServer[],
    mode?: McpMode,
    scope?: MemoryScope,
  ): Offered;
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  toolName?(offered: Offered, call: ToolCall): string;
  routes?: RouteDescriptor[];
};

export type ToolsArea = Tools & {
  store: ToolStore;
  routes: RouteDescriptor[];
};

// the memory phase is offered memory_edit and nothing else; a call to
// anything the run had gets the reason rather than a bare not found
const PHASE_ONLY = "only memory_edit is offered in the memory phase.";

export function toolsArea(deps: ToolsDeps): ToolsArea {
  const store = new ToolStore(deps.db);
  const skillStore: SkillsPort = deps.skills;
  const mcpService = deps.mcp ?? {
    offered: () => ({
      servers: [],
      prompt: {
        text: "",
        included: [],
        leftForSchemas: [],
        leftForInstructions: [],
        digest: {},
      },
    }),
    async call() {
      throw new Error("MCP is not configured");
    },
    validateArguments: () => null,
  };
  const memorySessions = {
    snapshot: (projectId: string, sessionId: string) =>
      deps.sessions?.memorySnapshot(projectId, sessionId) ?? null,
    unread: (
      automationId: string,
      projectId: string,
      cap: number,
      exclude: readonly string[],
    ) =>
      deps.markers?.unread(automationId, projectId, cap, exclude) ?? {
        chats: [],
        remaining: 0,
      },
  };
  const fetchDeps: FetchDependencies = deps.fetchDeps ?? {
    fetch: deps.fetcher,
  };
  const searchDeps: SearchDependencies = deps.searchDeps ?? {
    fetch: deps.fetcher,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };

  const toolsFor = (
    search: SearchProvider,
    hosts: readonly string[],
  ): Tool[] => [
    datetimeTool,
    makeWebfetchTool(deps.version, fetchDeps),
    makeWebsearchTool(
      () => deps.secret(`search-${search}`),
      search,
      deps.version,
      searchDeps,
    ),
    makeVisualizeTool(hosts),
  ];

  const mcpTools = (servers: OfferedServer[], ctx: ToolContext): Tool[] =>
    servers.flatMap((server) =>
      server.tools.map((tool: OfferedMcpTool) => {
        const timeoutMs = server.timeoutMs ?? ctx.caps.callTimeoutMs;
        return {
          name: tool.wireName,
          description: tool.description,
          parameters: tool.wireInputSchema,
          timeoutMs,
          run: (args: Record<string, unknown>, runCtx: ToolContext) =>
            mcpService.call(server, tool, args, {
              signal: runCtx.signal,
              timeoutMs,
              bodyBytes: runCtx.caps.fetchBodyBytes,
            }),
        };
      }),
    );

  const response = (now: number): ToolsResponse => {
    const rows = new Map(store.rows().map((row) => [row.name, row]));
    const selected = rows.get("websearch")?.provider ?? "exa";
    const schemas = new Map(
      fillYear(toolsFor(selected, rows.get("visualize")!.hosts), now).map(
        (tool) => [tool.name, tool],
      ),
    );
    const web = WEB_TOOLS.map((name): ToolsResponse["web"][number] => {
      const row = rows.get(name)!;
      const tool = schemas.get(name)!;
      return {
        name,
        description: tool.description,
        parameters: tool.parameters,
        parametersHtml: parametersHtml(tool, deps.render),
        tokens: wireTokens([tool]),
        enabled: row.enabled,
        hosts: row.hosts,
        updatedAt: row.updatedAt,
      };
    });
    return {
      builtin: builtinCatalog(now, deps.render),
      web,
      search: {
        provider: rows.get("websearch")!.provider,
        keys: {
          exa: deps.secret("search-exa") !== null,
          firecrawl: deps.secret("search-firecrawl") !== null,
          tavily: deps.secret("search-tavily") !== null,
        },
      },
    };
  };

  const patch = (
    name: WebTool,
    change: PatchToolRequest,
    now: number,
  ): void => {
    transact(deps.db, () => {
      if (change.enabled !== undefined) {
        store.setEnabled(name, change.enabled, now);
      }
      if ("provider" in change) store.setProvider(change.provider ?? null, now);
      if (change.hosts !== undefined) store.setHosts(change.hosts, now);
      return { result: undefined };
    });
  };

  const area: ToolsArea = {
    store,
    routes: [],
    offered(now, agentId, agentServers, requestedMode, scope) {
      return offered(
        {
          store,
          skills: skillStore,
          mcp: mcpService,
          memory: deps.memory,
          memorySessions,
          toolsFor,
          log: deps.log,
        },
        now,
        agentId,
        agentServers,
        requestedMode,
        scope,
      );
    },
    toolName(offered, call) {
      return mcpCallName(offered.mcp, call) ?? call.name;
    },
    async run(offered, call, ctx) {
      const memory = offered.memory;
      if (
        memory !== null &&
        isMemoryTool(call.name) &&
        (memory.stopped || memory.read !== null || call.name === "memory_edit")
      ) {
        return runMemory(memory, memorySessions, call, ctx);
      }
      const allowed = new Set(offered.tools.map((tool) => tool.name));
      const base = [
        ...toolsFor(offered.search ?? "exa", []).filter((tool) =>
          allowed.has(tool.name),
        ),
        ...makeSkillTools(offered.skills.skills, skillStore),
      ];
      const direct = mcpTools(offered.mcp, ctx);
      if (call.name === "mcp_call" && allowed.has("mcp_call")) {
        try {
          const target = resolveMcpCall(
            offered.mcp,
            call,
            mcpService.validateArguments,
          );
          return new Registry([...base, ...direct]).run(target, ctx);
        } catch (error) {
          const failed: Tool = {
            name: "mcp_call",
            description: "",
            parameters: {},
            async run() {
              throw error;
            },
          };
          return new Registry([failed]).run({ ...call, arguments: "{}" }, ctx);
        }
      }
      if (offered.memory?.note === "automation") {
        return new Registry(base, () => PHASE_ONLY).run(call, ctx);
      }
      const runtime =
        offered.mcpCatalog === ""
          ? [...base, ...direct]
          : [...base, ...makeMcpCatalogTools(offered.mcp)];
      return new Registry(runtime).run(call, ctx);
    },
  };
  area.routes = routes({
    clock: deps.clock,
    response,
    patch,
    visualHosts: () =>
      store.rows().find((row) => row.name === "visualize")!.hosts,
  });
  return area;
}
