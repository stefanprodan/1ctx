// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schemas and context captured for one send. Keeping this selection
// apart from dispatch lets the agent page and the runner share the same
// offered set without needing a live call context.

import { mcpKey, WEB } from "../../shared/capabilities.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import {
  mcpCatalog,
  type PromptServer,
  promptSnapshot,
  resolveMode,
} from "../../shared/mcp.ts";
import { catalog } from "../../shared/skills.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import type { McpMode, SearchProvider } from "../../shared/words.ts";
import { sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import type { Mcp, OfferedServer } from "../mcp/index.ts";
import type { MemoryCapability } from "../memory/index.ts";
import { type ChatTool, wireTokens } from "../providers/index.ts";
import { CATALOG_CAP } from "../skills/index.ts";
import { makeMcpCatalogTools } from "./builtin/mcp.ts";
import {
  type MemorySessionsPort,
  makeMemoryHandle,
  makeMemoryTools,
} from "./builtin/memory.ts";
import { makeSkillTools, type SkillToolsPort } from "./builtin/skill.ts";
import { fillYear, schema } from "./catalog.ts";
import type { ToolStore } from "./store.ts";
import type {
  MemoryHandle,
  MemoryScope,
  Offered,
  Tool,
  ToolResult,
} from "./types.ts";

export type SkillsPort = SkillToolsPort & {
  forAgent(agentId: string): OfferedSkill[];
};

type OfferDeps = {
  store: Pick<ToolStore, "rows">;
  skills: SkillsPort;
  mcp: Pick<Mcp, "offered">;
  memory?: Pick<MemoryCapability, "work">;
  memorySessions: MemorySessionsPort;
  toolsFor(
    search: SearchProvider | null,
    hosts: readonly string[],
    web: WebSnapshot | null,
  ): Tool<string | ToolResult>[];
  log: Log;
};

function memoryFor(
  memory: OfferDeps["memory"],
  scope?: MemoryScope,
): MemoryHandle | null {
  if (
    scope === undefined ||
    scope.projectId === null ||
    scope.automation === null ||
    memory === undefined
  ) {
    return null;
  }
  if (scope.phase === "memory") {
    if (!scope.automation.ownMemory) return null;
    return makeMemoryHandle(
      memory.work(scope.projectId, scope.automation.id),
      scope.automation.id,
    );
  }
  if (!scope.automation.projectMemory) return null;
  return makeMemoryHandle(
    memory.work(scope.projectId, null),
    scope.automation.id,
  );
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

export function offered(
  deps: OfferDeps,
  now: number,
  agentId: string,
  agentServers: AgentServer[] = [],
  requestedMode: McpMode = "auto",
  scope?: MemoryScope,
  disabledCapabilities: readonly string[] = [],
): Offered {
  const memory = memoryFor(deps.memory, scope);
  if (scope?.phase === "memory") {
    const phaseTools =
      memory === null ? [] : makeMemoryTools(memory, deps.memorySessions);
    return {
      tools: fillYear(phaseTools.map(schema), now),
      web: null,
      search: null,
      skills: { block: "", skills: [] },
      mcp: [],
      mcpPrompt: { text: "", digest: {} },
      mcpCatalog: "",
      memory,
    };
  }
  const rows = new Map(deps.store.rows().map((row) => [row.name, row]));
  const searchRow = rows.get("websearch")!;
  const access = rows.get("web")!;
  const web: WebSnapshot | null =
    access.mode === "off" || disabledCapabilities.includes(WEB)
      ? null
      : {
          mode: access.mode as WebSnapshot["mode"],
          domains: [...access.hosts],
        };
  const search = web === null ? null : searchRow.provider;
  const allowed = new Set<string>([
    "datetime",
    "bash",
    ...(web === null ? [] : ["webfetch"]),
    ...(search === null ? [] : ["websearch"]),
    ...(rows.get("visualize")!.enabled ? ["visualize"] : []),
  ]);
  const skillCatalog = catalog(deps.skills.forAgent(agentId), CATALOG_CAP);
  for (const name of skillCatalog.leftOut) {
    deps.log(`skill ${name} left out of the catalog`);
  }
  const skills = {
    block: skillCatalog.text,
    skills: skillCatalog.included,
  };
  const baseTools = fillYear(
    [
      ...deps
        .toolsFor(search, rows.get("visualize")!.hosts, web)
        .filter((tool) => allowed.has(tool.name)),
      ...makeSkillTools(skills.skills, deps.skills),
      ...(memory === null ? [] : makeMemoryTools(memory, deps.memorySessions)),
    ].map(schema),
    now,
  );
  const offered = deps.mcp.offered(
    agentServers.filter(
      (link) => !disabledCapabilities.includes(mcpKey(link.serverId)),
    ),
  );
  let mcp = offered.servers;
  let mcpPrompt = {
    text: offered.prompt.text,
    digest: offered.prompt.digest,
  };
  let mcpCatalogText = "";
  const allSchemas = directSchemas(mcp);
  const schemaTokens = wireTokens(allSchemas);
  const mode = resolveMode(requestedMode, schemaTokens);
  let mcpSchemas = allSchemas;
  if (mode === "catalog" && mcp.length > 0) {
    const catalogOffer = mcpCatalog(promptServers(mcp));
    for (const name of catalogOffer.leftOut) {
      deps.log(`server ${name} left out: its catalog is over the prompt cap`);
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
    web,
    search,
    skills,
    mcp,
    mcpPrompt,
    mcpCatalog: mcpCatalogText,
    memory,
  };
}
