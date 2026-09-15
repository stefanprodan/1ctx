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
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import {
  mcpCatalog,
  type PromptServer,
  promptSnapshot,
  resolveMode,
} from "../../shared/mcp.ts";
import { catalog } from "../../shared/skills.ts";
import {
  BUILTIN_TOOLS,
  type BuiltinTool,
  type McpMode,
  type SearchProvider,
} from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import { tokens } from "../lib/tokens.ts";
import type { Mcp, OfferedMcpTool, OfferedServer } from "../mcp/index.ts";
import { type ChatTool, type ToolCall, wireTools } from "../providers/index.ts";
import { CATALOG_CAP } from "../skills/index.ts";
import {
  DEFAULT_TIMEZONE,
  datetimeTool,
  formatDatetime,
} from "./builtin/datetime.ts";
import {
  makeMcpCatalogTools,
  mcpCallName,
  resolveMcpCall,
} from "./builtin/mcp.ts";
import { makeSkillTools, type SkillToolsPort } from "./builtin/skill.ts";
import {
  type FetchDependencies,
  makeWebfetchTool,
} from "./builtin/webfetch.ts";
import {
  makeWebsearchTool,
  type SearchDependencies,
} from "./builtin/websearch.ts";
import { Registry } from "./registry.ts";
import { routes } from "./routes.ts";
import { ToolStore } from "./store.ts";
import type { Offered, Tool, ToolContext, ToolResult } from "./types.ts";

export { DEFAULT_TIMEZONE, formatDatetime } from "./builtin/datetime.ts";
export { TOOL_CAPS } from "./limits.ts";
export { parseToolName, parseToolPatch } from "./parse.ts";
export { type ToolRow, ToolStore } from "./store.ts";
export type {
  Offered,
  Tool,
  ToolBudget,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "./types.ts";

export type SkillsPort = SkillToolsPort & {
  forAgent(agentId: string): OfferedSkill[];
};

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
  fetchDeps?: FetchDependencies;
  searchDeps?: SearchDependencies;
};

export type Tools = {
  offered(
    now: number,
    agentId: string,
    agentServers?: AgentServer[],
    mode?: McpMode,
  ): Offered;
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  toolName?(offered: Offered, call: ToolCall): string;
  routes?: RouteDescriptor[];
};

export type ToolsArea = Tools & {
  store: ToolStore;
  routes: RouteDescriptor[];
};

function fillYear(tools: ChatTool[], now: number): ChatTool[] {
  const year = formatDatetime(now, DEFAULT_TIMEZONE).datetime.slice(0, 4);
  return tools.map((tool) => ({
    ...tool,
    description: tool.description.replaceAll("{{year}}", year),
  }));
}

function schema(tool: Tool): ChatTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function promptServers(servers: OfferedServer[]): PromptServer[] {
  return servers.map((server) => ({
    name: server.name,
    instructions: server.instructions,
    tools: server.tools.map((tool) => ({
      wireName: tool.wireName,
      description: tool.description,
      schemaJson: tool.schemaJson,
    })),
  }));
}

function directSchemas(servers: OfferedServer[]): ChatTool[] {
  return servers.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description,
      parameters: tool.wireInputSchema,
    })),
  );
}

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

  const toolsFor = (search: SearchProvider): Tool[] => [
    datetimeTool,
    makeWebfetchTool(deps.version, fetchDeps),
    makeWebsearchTool(
      () => deps.secret(search),
      search,
      deps.version,
      searchDeps,
    ),
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
      fillYear(toolsFor(selected), now).map((tool) => [tool.name, tool]),
    );
    const tools = BUILTIN_TOOLS.map((name): ToolsResponse["tools"][number] => {
      const row = rows.get(name)!;
      const tool = schemas.get(name)!;
      const json = JSON.stringify(tool.parameters, null, 2);
      return {
        name,
        description: tool.description,
        parameters: tool.parameters,
        parametersHtml: deps.render(`\`\`\`json\n${json}\n\`\`\``, false),
        enabled: row.enabled,
        updatedAt: row.updatedAt,
      };
    });
    return {
      tools,
      search: {
        provider: rows.get("websearch")!.provider,
        keys: {
          exa: deps.secret("exa") !== null,
          firecrawl: deps.secret("firecrawl") !== null,
          tavily: deps.secret("tavily") !== null,
        },
      },
    };
  };

  const patch = (
    name: BuiltinTool,
    change: PatchToolRequest,
    now: number,
  ): void => {
    transact(deps.db, () => {
      if (change.enabled !== undefined) {
        store.setEnabled(name, change.enabled, now);
      }
      if ("provider" in change) store.setProvider(change.provider ?? null, now);
      return { result: undefined };
    });
  };

  const area: ToolsArea = {
    store,
    routes: [],
    offered(now, agentId, agentServers = [], requestedMode = "auto") {
      const rows = new Map(store.rows().map((row) => [row.name, row]));
      const searchRow = rows.get("websearch")!;
      const search =
        searchRow.enabled && searchRow.provider !== null
          ? searchRow.provider
          : null;
      const allowed = new Set(
        [...rows.values()]
          .filter((row) => row.enabled && (row.name !== "websearch" || search))
          .map((row) => row.name),
      );
      const skillCatalog = catalog(skillStore.forAgent(agentId), CATALOG_CAP);
      for (const name of skillCatalog.leftOut) {
        deps.log(`skill ${name} left out of the catalog`);
      }
      const skills = {
        block: skillCatalog.text,
        skills: skillCatalog.included,
      };
      const baseTools = fillYear(
        [
          ...toolsFor(search ?? "exa").filter((tool) =>
            allowed.has(tool.name as BuiltinTool),
          ),
          ...makeSkillTools(skills.skills, skillStore),
        ].map(schema),
        now,
      );
      const offered = mcpService.offered(agentServers);
      let mcp = offered.servers;
      let mcpPrompt = {
        text: offered.prompt.text,
        digest: offered.prompt.digest,
      };
      let mcpCatalogText = "";
      const allSchemas = directSchemas(mcp);
      const schemaTokens = tokens(JSON.stringify(wireTools(allSchemas)));
      const mode = resolveMode(requestedMode, schemaTokens);
      let mcpSchemas = allSchemas;
      if (mode === "catalog" && mcp.length > 0) {
        const catalogOffer = mcpCatalog(promptServers(mcp));
        for (const name of catalogOffer.leftOut) {
          deps.log(
            `server ${name} left out: its catalog is over the prompt cap`,
          );
        }
        const included = new Set(catalogOffer.included);
        mcp = mcp.filter((server) => included.has(server.name));
        if (mcp.length !== offered.servers.length) {
          const snapshot = promptSnapshot(promptServers(mcp), sha256);
          mcpPrompt = { text: snapshot.text, digest: snapshot.digest };
        }
        mcpCatalogText = catalogOffer.text;
        mcpSchemas = makeMcpCatalogTools(mcp).map(schema);
      }
      return {
        tools: [...baseTools, ...mcpSchemas],
        search,
        skills,
        mcp,
        mcpPrompt,
        mcpCatalog: mcpCatalogText,
      };
    },
    toolName(offered, call) {
      return mcpCallName(offered.mcp, call) ?? call.name;
    },
    async run(offered, call, ctx) {
      const allowed = new Set(offered.tools.map((tool) => tool.name));
      const base = [
        ...toolsFor(offered.search ?? "exa").filter((tool) =>
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
      const runtime =
        offered.mcpCatalog === ""
          ? [...base, ...direct]
          : [...base, ...makeMcpCatalogTools(offered.mcp)];
      return new Registry(runtime).run(call, ctx);
    },
  };
  area.routes = routes({ clock: deps.clock, response, patch });
  return area;
}
