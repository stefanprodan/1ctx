// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A model deep in a run of bash calls types its other tools as commands,
// and a bare "command not found" keeps it guessing until the budget is
// spent. The line after it names the way out.

import type { Tool, ToolResult } from "./types.ts";

const NOT_FOUND = /^bash: (\S+): command not found$/gm;

// tools are the send's offered tool names, catalog the MCP wire names
// reached only through mcp_call
export function commandHints(
  content: string,
  tools: readonly string[],
  catalog: readonly string[],
): string {
  const named = new Set(tools.filter((name) => name !== "bash"));
  const listed = new Set(catalog);
  const seen = new Set<string>();
  return content.replace(NOT_FOUND, (line, name: string) => {
    if (seen.has(name)) return line;
    seen.add(name);
    if (named.has(name)) {
      return `${line}\n${name} is one of your tools, not a command: call it as a tool, outside bash.`;
    }
    if (listed.has(name)) {
      return `${line}\n${name} is an MCP tool, not a command: call the mcp_call tool with name ${name}, outside bash.`;
    }
    return line;
  });
}

export function withCommandHints(
  bash: Tool<string | ToolResult>,
  tools: readonly string[],
  catalog: readonly string[],
): Tool<string | ToolResult> {
  return {
    ...bash,
    async run(args, ctx) {
      const result = await bash.run(args, ctx);
      if (typeof result === "string") return result;
      return {
        ...result,
        content: commandHints(result.content, tools, catalog),
      };
    },
  };
}
