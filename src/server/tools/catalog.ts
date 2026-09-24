// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The built-ins as the tools page lists them. Each schema comes from the
// factory a send uses, called with sample inputs, so the page never
// restates a schema. A schema that lists skill or MCP tool names is shown
// with none, since the names are the send's.

import type {
  BuiltinToolSummary,
  ToolWhen,
} from "../../shared/contracts/tool.ts";
import { BUILTIN_TOOLS } from "../../shared/words.ts";
import type { OfferedServer } from "../mcp/index.ts";
import type { MemoryWork } from "../memory/index.ts";
import { type ChatTool, wireTokens } from "../providers/index.ts";
import { makeBashTool } from "./builtin/bash.ts";
import {
  DEFAULT_TIMEZONE,
  datetimeTool,
  formatDatetime,
} from "./builtin/datetime.ts";
import { makeMcpCatalogTools } from "./builtin/mcp.ts";
import { makeMemoryHandle, makeMemoryTools } from "./builtin/memory.ts";
import { makeSkillTools } from "./builtin/skill.ts";
import { makeWebfetchTool } from "./builtin/webfetch.ts";
import { makeWebsearchTool } from "./builtin/websearch.ts";
import type { Tool, ToolResult } from "./types.ts";

export function fillYear(tools: ChatTool[], now: number): ChatTool[] {
  const year = formatDatetime(now, DEFAULT_TIMEZONE).datetime.slice(0, 4);
  return tools.map((tool) => ({
    ...tool,
    description: tool.description.replaceAll("{{year}}", year),
  }));
}

export function schema(tool: Tool<string | ToolResult>): ChatTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

// the parameters as the page's highlighted JSON block
export function parametersHtml(
  tool: ChatTool,
  render: (markdown: string, streaming: boolean) => string,
): string {
  const json = JSON.stringify(tool.parameters, null, 2);
  return render(`\`\`\`json\n${json}\n\`\`\``, false);
}

const WHEN: Record<BuiltinToolSummary["name"], ToolWhen> = {
  bash: "knowledge",
  datetime: "always",
  skill: "skills",
  skill_file: "skillFiles",
  mcp_describe: "mcpCatalog",
  mcp_call: "mcpCatalog",
  memory_edit: "memory",
  webfetch: "web",
  websearch: "webSearch",
};

function memoryTools(): Tool[] {
  const work: MemoryWork = {
    target: { projectId: "", automationId: "" },
    baseRevision: 0,
    entries: [],
    operations: [],
    failedRounds: 0,
  };
  return makeMemoryTools(makeMemoryHandle(work));
}

// the name enum a send fills, emptied
function withoutNames(tool: Tool): Tool {
  const parameters = structuredClone(tool.parameters) as {
    properties?: { name?: { enum?: string[] } };
  };
  if (parameters.properties?.name?.enum !== undefined) {
    parameters.properties.name.enum = [];
  }
  return { ...tool, parameters };
}

export function builtinCatalog(
  now: number,
  render: (markdown: string, streaming: boolean) => string,
): BuiltinToolSummary[] {
  const server: OfferedServer = {
    id: "",
    name: "",
    url: "",
    keyName: null,
    timeoutMs: null,
    fingerprint: "",
    instructions: null,
    tools: [],
    checkedAt: 0,
    refreshFailedAt: null,
  };
  const skill = { id: "", name: "", description: "", hasFiles: true };
  const tools = fillYear(
    [
      makeBashTool(undefined, { mode: "all", domains: [] }, true),
      datetimeTool,
      makeWebfetchTool(""),
      makeWebsearchTool(() => null, "exa", ""),
      ...makeSkillTools([skill], {
        body: () => null,
        file: () => null,
      }).map(withoutNames),
      ...makeMcpCatalogTools([server]),
      ...memoryTools(),
    ].map(schema),
    now,
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const names: BuiltinToolSummary["name"][] = [
    ...BUILTIN_TOOLS,
    "webfetch",
    "websearch",
  ];
  return names.sort().map((name) => {
    const tool = byName.get(name);
    if (tool === undefined) throw new Error(`no schema for ${name}`);
    return {
      name,
      description: tool.description,
      parameters: tool.parameters,
      parametersHtml: parametersHtml(tool, render),
      tokens: wireTokens([tool]),
      when: WHEN[name],
      names:
        "enum" in
        ((tool.parameters as { properties?: { name?: object } }).properties
          ?.name ?? {}),
      variant: null,
    };
  });
}
